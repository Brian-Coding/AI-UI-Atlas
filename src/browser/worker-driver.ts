// Bun-side client for the Node Playwright worker (scripts/browser-worker.mjs).
//
// The worker is spawned lazily on first use, listens on a random loopback
// port, and is shut down by close(). Playwright work stays in Node because
// Playwright's launch has been unreliable under Bun on some platforms.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fetchWithTimeout, readJsonResponseWithTimeout } from '../core/external-io';
import { terminateNodeChildProcess, waitForNodeChildExit } from '../core/node-child-process';
import type {
  BrowserDriver,
  RunEvidence,
  FinalizedRunEvidence,
  BrowserStatus,
  ConsoleEntry,
  NetworkEntry,
  ScreenshotRequest,
} from './driver';

const WORKER_SCRIPT = resolve(import.meta.dir, '../../scripts/browser-worker.mjs');
const WORKER_READY_TIMEOUT_MS = 30_000;
const WORKER_FETCH_TIMEOUT_MS = 30_000;

const BROWSER_WORKER_ENV_KEYS = new Set([
  'path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir',
  'home', 'userprofile', 'localappdata', 'appdata', 'lang', 'display',
  'wayland_display', 'xauthority', 'dbus_session_bus_address',
  'playwright_browsers_path', 'playwright_skip_browser_download',
  'atlas_qa_headed', 'atlas_qa_slowmo', 'http_proxy', 'https_proxy', 'no_proxy',
  'node_extra_ca_certs',
]);

/** The worker needs OS and Playwright settings, never provider API secrets. */
export function buildBrowserWorkerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toLowerCase();
    if (typeof value === 'string'
      && (BROWSER_WORKER_ENV_KEYS.has(normalized)
        || normalized.startsWith('lc_')
        || normalized.startsWith('xdg_'))) {
      env[key] = value;
    }
  }
  return env;
}

export function parseWorkerReadyPort(output: string): number | null {
  const match = output.match(/(?:^|\r?\n)READY:(\d+)(?:\r?\n|$)/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export interface WorkerBrowserDriverOptions {
  /** Node executable; defaults to `node` on PATH (or ATLAS_QA_NODE). */
  nodeBinary?: string;
  /** Extra environment entries for the worker (e.g. ATLAS_QA_HEADED). */
  env?: Record<string, string>;
  log?: (line: string) => void;
}

export class WorkerBrowserDriver implements BrowserDriver {
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private ready: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private readonly token = randomBytes(32).toString('hex');

  constructor(private readonly options: WorkerBrowserDriverOptions = {}) {}

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.port !== null;
  }

  /** PID of the current worker, if any. Exposed for diagnostics and tests. */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  async launch(): Promise<void> {
    if (this.closing) await this.closing;
    if (this.ready) return this.ready;
    const log = this.options.log ?? ((line: string) => console.error(line));

    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      const node = this.options.nodeBinary || process.env.ATLAS_QA_NODE || 'node';
      const proc = spawn(node, [WORKER_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...buildBrowserWorkerEnv(process.env), ...(this.options.env ?? {}), ATLAS_QA_WORKER_TOKEN: this.token },
      });
      this.proc = proc;
      let settled = false;
      const reset = () => {
        if (this.proc === proc) {
          this.proc = null;
          this.port = null;
          this.ready = null;
        }
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        void terminateNodeChildProcess(proc).finally(() => {
          reset();
          rejectReady(new Error(`Browser worker did not become ready within ${WORKER_READY_TIMEOUT_MS}ms`));
        });
      }, WORKER_READY_TIMEOUT_MS);

      let stdoutBuffer = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8');
        const readyPort = parseWorkerReadyPort(stdoutBuffer);
        if (readyPort !== null && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.port = readyPort;
          resolveReady();
        }
        if (stdoutBuffer.length > 64_000) stdoutBuffer = stdoutBuffer.slice(-64_000);
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trimEnd();
        if (text) log(`[browser-worker] ${text}`);
      });

      proc.on('exit', (code, signal) => {
        const wasCurrent = this.proc === proc;
        reset();
        if (wasCurrent && !settled) {
          settled = true;
          clearTimeout(timeout);
          rejectReady(new Error(`Browser worker exited before ready (code=${code}, signal=${signal}). Is Playwright's Chromium installed? Run: bun run browsers:install`));
        }
      });

      proc.on('error', (error) => {
        if (settled) {
          log(`[browser-worker] process error: ${error.message}`);
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reset();
        rejectReady(error);
      });
    });
    return this.ready;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const proc = this.proc;
    if (!proc) return;
    const closing = (async () => {
      try {
        await this.request('POST', '/shutdown', undefined, 3000);
      } catch { /* worker may already be down */ }
      await waitForNodeChildExit(proc, 2000);
      await terminateNodeChildProcess(proc);
      if (this.proc === proc) {
        this.proc = null;
        this.port = null;
        this.ready = null;
      }
    })();
    this.closing = closing;
    try {
      await closing;
    } finally {
      if (this.closing === closing) this.closing = null;
    }
  }

  private async request(
    method: 'GET' | 'POST',
    pathname: string,
    body?: unknown,
    timeoutMs = WORKER_FETCH_TIMEOUT_MS,
  ): Promise<any> {
    if (this.ready) await this.ready;
    if (this.port == null) throw new Error('Browser worker is not running');
    const headers: Record<string, string> = { 'x-atlas-worker-token': this.token };
    const init: RequestInit = { method, headers };
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    const label = `Browser worker ${method} ${pathname.split('?')[0]}`;
    const startedAt = Date.now();
    const response = await fetchWithTimeout(`http://127.0.0.1:${this.port}${pathname}`, init, timeoutMs, label);
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
    const json = await readJsonResponseWithTimeout(response, 4 * 1024 * 1024, remainingMs, label) as any;
    if (!response.ok || (json && typeof json === 'object' && json.ok === false)) {
      throw new Error(json?.error || `Browser worker returned HTTP ${response.status}`);
    }
    return json;
  }

  private async call(method: 'GET' | 'POST', pathname: string, body?: unknown, timeoutMs?: number): Promise<any> {
    await this.launch();
    return this.request(method, pathname, body, timeoutMs);
  }

  private query(sessionId: string): string {
    return `?browserSessionId=${encodeURIComponent(sessionId)}`;
  }

  async beginEvidence(sessionId: string): Promise<void> {
    await this.call('POST', '/evidence/begin', { browserSessionId: sessionId });
  }

  async endEvidence(sessionId: string): Promise<void> {
    if (!this.isRunning()) return;
    await this.request('POST', '/evidence/end', { browserSessionId: sessionId });
  }

  async readEvidence(sessionId: string): Promise<RunEvidence> {
    // Do not restart a lost worker and silently claim a complete journal.
    return this.request('GET', '/evidence' + this.query(sessionId));
  }

  async finalizeEvidence(sessionId: string): Promise<FinalizedRunEvidence> {
    // A lost worker must fail validation, never start a replacement journal.
    return this.request('POST', '/evidence/finalize', { browserSessionId: sessionId });
  }

  async navigate(sessionId: string, url: string): Promise<{ url: string; title: string }> {
    const result = await this.call('POST', '/navigate', { browserSessionId: sessionId, url });
    return { url: result.url, title: result.title };
  }

  async screenshot(sessionId: string, request: ScreenshotRequest): Promise<string> {
    const result = await this.call('POST', '/screenshot', { browserSessionId: sessionId, ...request });
    return result.path;
  }

  async click(sessionId: string, selector: string): Promise<void> {
    await this.call('POST', '/click', { browserSessionId: sessionId, selector });
  }

  async type(sessionId: string, selector: string, text: string): Promise<void> {
    await this.call('POST', '/type', { browserSessionId: sessionId, selector, text });
  }

  async waitForReady(sessionId: string): Promise<{ duration: number }> {
    const result = await this.call('POST', '/wait-for-ready', { browserSessionId: sessionId });
    return { duration: result.duration };
  }

  async evaluate(sessionId: string, script: string): Promise<unknown> {
    const result = await this.call('POST', '/evaluate', { browserSessionId: sessionId, script }, 20_000);
    return result.result;
  }

  async setViewport(sessionId: string, width: number, height: number): Promise<void> {
    await this.call('POST', '/viewport', { browserSessionId: sessionId, width, height });
  }

  async getConsole(sessionId: string): Promise<ConsoleEntry[]> {
    if (!this.isRunning()) return [];
    return (await this.request('GET', `/console${this.query(sessionId)}`)).entries ?? [];
  }

  async clearConsole(sessionId: string): Promise<void> {
    if (!this.isRunning()) return;
    await this.request('POST', '/console/clear', { browserSessionId: sessionId });
  }

  async getNetwork(sessionId: string): Promise<NetworkEntry[]> {
    if (!this.isRunning()) return [];
    return (await this.request('GET', `/network${this.query(sessionId)}`)).entries ?? [];
  }

  async clearNetwork(sessionId: string): Promise<void> {
    if (!this.isRunning()) return;
    await this.request('POST', '/network/clear', { browserSessionId: sessionId });
  }

  async status(sessionId: string): Promise<BrowserStatus> {
    if (!this.isRunning()) return { running: false };
    return this.request('GET', `/status${this.query(sessionId)}`);
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.isRunning()) return;
    await this.request('POST', '/session/close', { browserSessionId: sessionId });
  }
}
