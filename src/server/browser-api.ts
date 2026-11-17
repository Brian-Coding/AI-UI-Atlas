// HTTP API under /api/browser/* that LLM agents call (usually with curl) to
// drive a real browser. Adapted from Agent Forge's browser routes: the same
// endpoints and validation, minus workspace coupling. Each handler is a thin,
// validated wrapper around a BrowserDriver.

import { existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { BrowserDriver } from '../browser/driver';
import { readJsonBody, RequestBodyError } from '../core/request-body';
import { isPathInside, isSafeId, safeSegment } from '../core/paths';
import { errorResponse, jsonResponse, tokenFromRequest, tokensMatch } from './http';
import type { SessionRegistry } from './sessions';

export const BROWSER_API_PREFIX = '/api/browser';
const BODY_LIMIT_BYTES = 1024 * 1024;
const STUCK_REPEAT_THRESHOLD = 5;
const HISTORY_LIMIT = 20;
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'data:']);

export type BrowserApiEvent =
  | { type: 'call'; sessionId: string; endpoint: string; detail?: string }
  | { type: 'screenshot'; sessionId: string; path: string }
  | { type: 'error'; sessionId: string; endpoint: string; message: string }
  | { type: 'stuck'; sessionId: string; endpoint: string; repeatCount: number; argsPreview: string };

export interface BrowserApiOptions {
  driver: BrowserDriver;
  sessions: SessionRegistry;
  /** When set, every request must present this token. */
  token?: string;
  /** Root for screenshots from sessions that no run has registered. */
  adhocScreenshotRoot: string;
  onEvent?: (event: BrowserApiEvent) => void;
}

interface CallRecord { endpoint: string; argsHash: string }

class BadRequest extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body?.[key];
  if (typeof value !== 'string' || value.length === 0) throw new BadRequest(`${key} required`);
  return value;
}

function sessionIdFrom(value: unknown): string {
  if (value == null || value === '') return 'default';
  if (!isSafeId(value)) throw new BadRequest('invalid browserSessionId');
  return value;
}

function validateUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BadRequest('url must be an absolute URL');
  }
  if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
    throw new BadRequest(`url protocol ${parsed.protocol} is not allowed (use http, https, about, or data)`);
  }
  return raw;
}

export function createBrowserApi(options: BrowserApiOptions) {
  const { driver, sessions } = options;
  const history = new Map<string, CallRecord[]>();
  const lastWarned = new Map<string, string>();
  const emit = (event: BrowserApiEvent) => {
    try { options.onEvent?.(event); } catch {}
  };

  // If an agent makes the same call five times in a row it is probably stuck.
  // Surface one advisory event per streak; a different call resets it.
  function track(sessionId: string, endpoint: string, args: unknown): void {
    let argsHash: string;
    try { argsHash = JSON.stringify(args ?? {}).slice(0, 200); } catch { argsHash = '<unserializable>'; }
    const records = history.get(sessionId) ?? [];
    records.push({ endpoint, argsHash });
    while (records.length > HISTORY_LIMIT) records.shift();
    history.set(sessionId, records);
    if (records.length < STUCK_REPEAT_THRESHOLD) return;
    const recent = records.slice(-STUCK_REPEAT_THRESHOLD);
    const allSame = recent.every(item => item.endpoint === endpoint && item.argsHash === argsHash);
    const streakKey = `${endpoint}|${argsHash}`;
    if (allSame) {
      if (lastWarned.get(sessionId) !== streakKey) {
        lastWarned.set(sessionId, streakKey);
        emit({ type: 'stuck', sessionId, endpoint, repeatCount: STUCK_REPEAT_THRESHOLD, argsPreview: argsHash });
      }
    } else {
      lastWarned.delete(sessionId);
    }
  }

  async function screenshotDirectory(sessionId: string, body: Record<string, unknown>): Promise<string> {
    const grant = sessions.get(sessionId);
    if (body.runId !== undefined && body.runId !== null && body.runId !== '') {
      if (!isSafeId(body.runId)) throw new BadRequest('invalid runId');
      if (grant?.runId && grant.runId !== body.runId) throw new BadRequest('runId does not match this browser session', 403);
    }
    const root = grant?.screenshotDir ?? join(resolve(options.adhocScreenshotRoot), safeSegment(sessionId, 'default'));
    // An explicit outDir is accepted only when it stays inside the session's
    // own screenshot root, lexically and after resolving symlinks.
    const requested = typeof body.outDir === 'string' && body.outDir.trim() ? resolve(body.outDir.trim()) : root;
    if (!isPathInside(root, requested)) throw new BadRequest('outDir must be inside this session\'s screenshot directory', 403);
    // Check existing ancestors too: a new subdirectory under a symlink must
    // not bypass confinement just because the final directory is absent.
    for (let current = requested; ; current = dirname(current)) {
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (info?.isSymbolicLink()) throw new BadRequest('Screenshot directories cannot contain symlinks', 403);
      if (current === root) break;
    }
    if (existsSync(requested) && existsSync(root)) {
      const [realRoot, realRequested] = await Promise.all([realpath(root), realpath(requested)]);
      if (!isPathInside(realRoot, realRequested)) throw new BadRequest('outDir resolves outside this session\'s screenshot directory', 403);
    }
    return requested;
  }

  async function readBody(req: Request): Promise<Record<string, unknown>> {
    try {
      const body = await readJsonBody(req, BODY_LIMIT_BYTES);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Request body must be a JSON object');
      return body as Record<string, unknown>;
    } catch (error) {
      if (error instanceof RequestBodyError) throw new BadRequest(error.message, error.status);
      throw error;
    }
  }

  type Handler = (req: Request, url: URL) => Promise<unknown>;

  const post = (endpoint: string, run: (body: Record<string, unknown>, sessionId: string) => Promise<unknown>): Handler =>
    async req => {
      const body = await readBody(req);
      const sessionId = sessionIdFrom(body.browserSessionId);
      return run(body, sessionId);
    };
  const get = (run: (sessionId: string, url: URL) => Promise<unknown>): Handler =>
    async (_req, url) => run(sessionIdFrom(url.searchParams.get('browserSessionId')), url);

  const routes: Record<string, Handler> = {
    'POST /navigate': post('navigate', async (body, sessionId) => {
      const url = validateUrl(requireString(body, 'url'));
      track(sessionId, 'navigate', { url });
      emit({ type: 'call', sessionId, endpoint: 'navigate', detail: url });
      return { ok: true, ...(await driver.navigate(sessionId, url)) };
    }),
    'POST /screenshot': post('screenshot', async (body, sessionId) => {
      const outDir = await screenshotDirectory(sessionId, body);
      track(sessionId, 'screenshot', { selector: body.selector, fullPage: body.fullPage === true, name: body.name });
      const path = await driver.screenshot(sessionId, {
        outDir,
        name: typeof body.name === 'string' ? body.name : undefined,
        selector: typeof body.selector === 'string' && body.selector ? body.selector : undefined,
        fullPage: body.fullPage === true,
      });
      emit({ type: 'screenshot', sessionId, path });
      return { ok: true, path };
    }),
    'POST /click': post('click', async (body, sessionId) => {
      const selector = requireString(body, 'selector');
      track(sessionId, 'click', { selector });
      emit({ type: 'call', sessionId, endpoint: 'click', detail: selector });
      await driver.click(sessionId, selector);
      return { ok: true };
    }),
    'POST /type': post('type', async (body, sessionId) => {
      const selector = requireString(body, 'selector');
      if (typeof body.text !== 'string') throw new BadRequest('text required');
      track(sessionId, 'type', { selector, textLength: body.text.length });
      emit({ type: 'call', sessionId, endpoint: 'type', detail: selector });
      await driver.type(sessionId, selector, body.text);
      return { ok: true };
    }),
    'POST /wait-for-ready': post('wait-for-ready', async (_body, sessionId) => {
      track(sessionId, 'wait-for-ready', {});
      return { ok: true, ...(await driver.waitForReady(sessionId)) };
    }),
    'POST /evaluate': post('evaluate', async (body, sessionId) => {
      const script = requireString(body, 'script');
      track(sessionId, 'evaluate', { scriptLength: script.length });
      emit({ type: 'call', sessionId, endpoint: 'evaluate', detail: `${script.length} chars` });
      return { ok: true, result: await driver.evaluate(sessionId, script) };
    }),
    'POST /viewport': post('viewport', async (body, sessionId) => {
      const width = Number(body.width);
      const height = Number(body.height);
      if (!Number.isInteger(width) || width < 320 || width > 7680) throw new BadRequest('width must be an integer from 320 to 7680');
      if (!Number.isInteger(height) || height < 240 || height > 4320) throw new BadRequest('height must be an integer from 240 to 4320');
      track(sessionId, 'viewport', { width, height });
      await driver.setViewport(sessionId, width, height);
      return { ok: true, width, height };
    }),
    'POST /console/clear': post('console/clear', async (_body, sessionId) => {
      await driver.clearConsole(sessionId);
      return { ok: true };
    }),
    'POST /network/clear': post('network/clear', async (_body, sessionId) => {
      await driver.clearNetwork(sessionId);
      return { ok: true };
    }),
    'POST /session/close': post('session/close', async (_body, sessionId) => {
      await driver.closeSession(sessionId);
      return { ok: true };
    }),
    'GET /console': get(async sessionId => ({ ok: true, entries: await driver.getConsole(sessionId) })),
    'GET /network': get(async sessionId => ({ ok: true, entries: await driver.getNetwork(sessionId) })),
    'GET /status': get(async sessionId => ({ ok: true, ...(await driver.status(sessionId)) })),
  };
  // Agent Forge called this endpoint /context/close; keep the alias.
  routes['POST /context/close'] = routes['POST /session/close']!;

  /** Returns a Response for /api/browser/* paths, or null for anything else. */
  return async function handle(req: Request, url: URL): Promise<Response | null> {
    if (!url.pathname.startsWith(`${BROWSER_API_PREFIX}/`)) return null;
    if (options.token && !tokensMatch(options.token, tokenFromRequest(req))) {
      return errorResponse('Missing or invalid x-atlas-qa-token header', 401);
    }
    const route = `${req.method} ${url.pathname.slice(BROWSER_API_PREFIX.length)}`;
    const handler = routes[route];
    if (!handler) return errorResponse(`No browser endpoint for ${route}`, 404);
    try {
      return jsonResponse(await handler(req, url));
    } catch (error) {
      if (error instanceof BadRequest) return errorResponse(error.message, error.status);
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: 'error', sessionId: 'unknown', endpoint: route, message });
      return errorResponse(message, 500);
    }
  };
}
