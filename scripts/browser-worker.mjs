import { ensureSafeDirectory, writeExclusiveArtifact } from './safe-artifacts.mjs';
// Node-side Playwright worker.
//
// Spawned by src/browser/worker-driver.ts. Listens on a random loopback port
// and exposes browser operations as JSON over HTTP. Prints `READY:<port>` to
// stdout once listening so the parent knows where to connect.
//
// Why a separate Node process? Playwright's launch() has been unreliable under
// Bun on some platforms because of child_process/IPC differences. Node runs it
// cleanly, so this boundary is intentional. Do not convert it to Bun without
// cross-platform evidence.
//
// The worker is never exposed to agents directly. The Bun server validates
// every request (session IDs, viewport ranges, screenshot directories) before
// forwarding it here.

import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { chromium } from 'playwright';
import {
  compileEvaluationScript,
  normalizeBrowserSessionId,
  screenshotFileName,
  singleFlight,
  withOperationTimeout,
} from './browser-worker-core.mjs';

const CONSOLE_LIMIT = 200;
const NETWORK_LIMIT = 300;
const READY_TIMEOUT_MS = 5000;
const READY_DOM_QUIET_MS = 500;
const EVALUATE_TIMEOUT_MS = 15_000;
const NAVIGATE_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 10_000;
const JSON_BODY_LIMIT_BYTES = 1024 * 1024;
const WORKER_TOKEN = process.env.ATLAS_QA_WORKER_TOKEN;
if (!WORKER_TOKEN) throw new Error('The browser worker must be started by atlas-qa');
delete process.env.ATLAS_QA_WORKER_TOKEN;

// Contexts unused for longer than CONTEXT_IDLE_MS are closed by a periodic
// sweep so long sessions do not accumulate retained DOM, GPU textures, etc.
const CONTEXT_IDLE_MS = 10 * 60 * 1000;
const CONTEXT_SWEEP_INTERVAL_MS = 60 * 1000;
const MEMORY_WARN_RSS_MB = 2048;
const MEMORY_CHECK_INTERVAL_MS = 60 * 1000;

let browser = null;
let browserGeneration = 0;
let shuttingDown = false;
let shutdownPromise = null;
const browserCreations = new Map();
// sessionId -> isolated Playwright state (one BrowserContext + one Page).
const contexts = new Map();
const evidence = new Map();
const EVIDENCE_LIMIT = 10_000;
function appendEvidence(session, kind, entry) {
  const journal = evidence.get(session.browserSessionId);
  if (!journal) return;
  if (journal[kind].length >= EVIDENCE_LIMIT) { journal.complete = false; return; }
  journal[kind].push(entry);
}
function loseEvidence(key) {
  const journal = evidence.get(key);
  if (journal) journal.complete = false;
}
const contextCreations = new Map();
const contextGenerations = new Map();

function recordConsole(session, level, text) {
  const entry = { level, text: text.slice(0, 2000), timestamp: Date.now() };
  appendEvidence(session, 'console', entry);
  session.consoleEntries.push(entry);
  if (session.consoleEntries.length > CONSOLE_LIMIT) {
    session.consoleEntries.splice(0, session.consoleEntries.length - CONSOLE_LIMIT);
  }
}

function recordNetwork(session, entry) {
  const captured = { ...entry, url: entry.url.slice(0, 4000), timestamp: Date.now() };
  appendEvidence(session, 'network', captured);
  session.networkEntries.push(captured);
  if (session.networkEntries.length > NETWORK_LIMIT) {
    session.networkEntries.splice(0, session.networkEntries.length - NETWORK_LIMIT);
  }
}

function launchOptions() {
  // Headless by default so runs work in CI and over SSH. ATLAS_QA_HEADED=1
  // opens a visible window, paced by slowMo so a person can follow along.
  const headed = process.env.ATLAS_QA_HEADED === '1';
  const defaultSlowMo = headed ? 250 : 0;
  const parsed = process.env.ATLAS_QA_SLOWMO != null ? parseInt(process.env.ATLAS_QA_SLOWMO, 10) : defaultSlowMo;
  const slowMo = Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 10_000) : defaultSlowMo;
  return { headless: !headed, slowMo };
}

async function ensureBrowser() {
  if (shuttingDown) throw new Error('Browser worker is shutting down');
  if (browser) return browser;
  return singleFlight(browserCreations, 'browser', async () => {
    if (browser) return browser;
    const generation = browserGeneration;
    const launched = await chromium.launch(launchOptions());
    if (shuttingDown || generation !== browserGeneration) {
      await launched.close().catch(() => {});
      throw new Error('Browser launch was cancelled by shutdown');
    }
    browser = launched;
    launched.on('disconnected', () => {
      if (browser !== launched) return;
      browser = null;
      for (const key of contexts.keys()) {
        contextGenerations.set(key, (contextGenerations.get(key) ?? 0) + 1);
      }
      for (const key of contexts.keys()) loseEvidence(key);
      contexts.clear();
    });
    return launched;
  });
}

function getSession(browserSessionId) {
  const key = normalizeBrowserSessionId(browserSessionId);
  const session = contexts.get(key);
  if (session) session.lastUsedAt = Date.now();
  return session;
}

async function ensureSession(browserSessionId) {
  if (shuttingDown) throw new Error('Browser worker is shutting down');
  const key = normalizeBrowserSessionId(browserSessionId);
  const existing = contexts.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  const generation = contextGenerations.get(key) ?? 0;
  return singleFlight(contextCreations, key, async () => {
    const browserInstance = await ensureBrowser();
    const context = await browserInstance.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      if (shuttingDown || generation !== (contextGenerations.get(key) ?? 0)) {
        throw new Error('Browser context creation was cancelled');
      }
      const session = {
        browserSessionId: key,
        context,
        page,
        consoleEntries: [],
        networkEntries: [],
        lastUsedAt: Date.now(),
      };
      page.on('console', (msg) => recordConsole(session, msg.type() || 'log', msg.text()));
      page.on('pageerror', (err) => recordConsole(session, 'error', err.message));
      page.on('response', (response) => {
        recordNetwork(session, {
          kind: 'response',
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
          ok: response.ok(),
        });
      });
      page.on('requestfailed', (request) => {
        recordNetwork(session, {
          kind: 'requestfailed',
          url: request.url(),
          method: request.method(),
          status: null,
          ok: false,
          error: request.failure()?.errorText || 'request failed',
        });
      });
      contexts.set(key, session);
      return session;
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  });
}

const idleSweepTimer = setInterval(async () => {
  const now = Date.now();
  for (const [key, session] of contexts.entries()) {
    if (now - session.lastUsedAt > CONTEXT_IDLE_MS) {
      console.warn(`[browser-worker] closing idle session ${key} (idle ${Math.round((now - session.lastUsedAt) / 60000)}m)`);
      contextGenerations.set(key, (contextGenerations.get(key) ?? 0) + 1);
      loseEvidence(key);
  contexts.delete(key);
      try { await session.context.close(); } catch {}
    }
  }
}, CONTEXT_SWEEP_INTERVAL_MS);
idleSweepTimer.unref?.();

const memoryCheckTimer = setInterval(() => {
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (rssMb > MEMORY_WARN_RSS_MB) {
    console.warn(`[browser-worker] memory warning: RSS ${rssMb} MB exceeds ${MEMORY_WARN_RSS_MB} MB (${contexts.size} active sessions).`);
  }
}, MEMORY_CHECK_INTERVAL_MS);
memoryCheckTimer.unref?.();

async function closeSession(browserSessionId) {
  const key = normalizeBrowserSessionId(browserSessionId);
  contextGenerations.set(key, (contextGenerations.get(key) ?? 0) + 1);
  const session = contexts.get(key);
  if (!session) return;
  loseEvidence(key);
  contexts.delete(key);
  try { await session.context.close(); } catch {}
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  browserGeneration++;
  for (const key of new Set([...contexts.keys(), ...contextCreations.keys()])) {
    contextGenerations.set(key, (contextGenerations.get(key) ?? 0) + 1);
  }
  shutdownPromise = (async () => {
    const active = [...contexts.values()];
    contexts.clear();
    await Promise.allSettled(active.map(session => session.context.close()));
    const pending = [...contextCreations.values(), ...browserCreations.values()];
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise(resolve => setTimeout(resolve, 1000)),
      ]);
    }
    const activeBrowser = browser;
    browser = null;
    if (activeBrowser) await activeBrowser.close().catch(() => {});
  })();
  return shutdownPromise;
}

// ============== HTTP handler ==============

async function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > JSON_BODY_LIMIT_BYTES) {
        if (!rejected) {
          rejected = true;
          reject(new Error(`JSON body exceeds ${JSON_BODY_LIMIT_BYTES} bytes`));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const handlers = {
  'POST /evidence/begin': async (body) => {
    const key = normalizeBrowserSessionId(body.browserSessionId);
    if (evidence.has(key)) throw new Error('Evidence already started for this session');
    await ensureSession(key);
    evidence.set(key, { complete: true, console: [], network: [], screenshots: [] });
    return { ok: true };
  },
  'GET /evidence': async (_body, query) => {
    const journal = evidence.get(normalizeBrowserSessionId(query.browserSessionId));
    if (!journal) throw new Error('No run evidence journal');
    return journal;
  },
  'GET /status': async (_body, query) => {
    const session = getSession(query.browserSessionId);
    if (!session) return { running: false };
    return {
      running: true,
      url: session.page.url(),
      title: await session.page.title().catch(() => ''),
      browserSessionId: session.browserSessionId,
    };
  },

  'POST /navigate': async (body) => {
    const session = await ensureSession(body.browserSessionId);
    await session.page.goto(body.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS });
    return { ok: true, url: session.page.url(), title: await session.page.title() };
  },

  'POST /screenshot': async (body) => {
    // The Bun server always supplies an absolute, pre-validated directory.
    if (typeof body.outDir !== 'string' || !isAbsolute(body.outDir)) {
      throw new Error('outDir (absolute path) is required');
    }
    const session = await ensureSession(body.browserSessionId);
    await ensureSafeDirectory(body.outDir);
    const filePath = join(body.outDir, screenshotFileName(body.name));
    let bytes;
    if (body.selector) {
      const element = await session.page.$(body.selector);
      if (!element) throw new Error(`Selector not found: ${body.selector}`);
      bytes = await element.screenshot({ type: 'png' });
    } else {
      bytes = await session.page.screenshot({ type: 'png', fullPage: !!body.fullPage });
    }
    await writeExclusiveArtifact(filePath, bytes);
    appendEvidence(session, 'screenshots', { path: filePath, sha256: createHash('sha256').update(bytes).digest('hex') });
    return { ok: true, path: filePath };
  },

  'POST /click': async (body) => {
    const session = await ensureSession(body.browserSessionId);
    await session.page.click(body.selector, { timeout: ACTION_TIMEOUT_MS });
    return { ok: true };
  },

  'POST /type': async (body) => {
    const session = await ensureSession(body.browserSessionId);
    await session.page.fill(body.selector, body.text, { timeout: ACTION_TIMEOUT_MS });
    return { ok: true };
  },

  'POST /wait-for-ready': async (body) => {
    const session = await ensureSession(body.browserSessionId);
    const start = Date.now();
    const networkIdle = session.page.waitForLoadState('networkidle', { timeout: READY_TIMEOUT_MS }).catch(() => {});
    const domQuiet = session.page.evaluate((quietMs) => new Promise((resolve) => {
      let timer = null;
      const reset = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { observer.disconnect(); resolve(); }, quietMs);
      };
      const observer = new MutationObserver(reset);
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      reset();
    }), READY_DOM_QUIET_MS).catch(() => {});
    const ceiling = new Promise(resolve => setTimeout(resolve, READY_TIMEOUT_MS));
    await Promise.race([Promise.all([networkIdle, domQuiet]), ceiling]);
    return { ok: true, duration: Date.now() - start };
  },

  'GET /console': async (_body, query) => {
    const session = getSession(query.browserSessionId);
    return { entries: session ? [...session.consoleEntries] : [] };
  },

  'POST /console/clear': async (body) => {
    const session = getSession(body.browserSessionId);
    if (session) session.consoleEntries = [];
    return { ok: true };
  },

  'GET /network': async (_body, query) => {
    const session = getSession(query.browserSessionId);
    return { entries: session ? [...session.networkEntries] : [] };
  },

  'POST /network/clear': async (body) => {
    const session = getSession(body.browserSessionId);
    if (session) session.networkEntries = [];
    return { ok: true };
  },

  'POST /viewport': async (body) => {
    const width = Number(body.width);
    const height = Number(body.height);
    if (!Number.isInteger(width) || width < 320 || width > 7680) {
      throw new Error('viewport width must be an integer from 320 to 7680');
    }
    if (!Number.isInteger(height) || height < 240 || height > 4320) {
      throw new Error('viewport height must be an integer from 240 to 4320');
    }
    const session = await ensureSession(body.browserSessionId);
    await session.page.setViewportSize({ width, height });
    return { ok: true, width, height };
  },

  'POST /session/close': async (body) => {
    await closeSession(body.browserSessionId);
    return { ok: true };
  },

  'POST /evaluate': async (body) => {
    const session = await ensureSession(body.browserSessionId);
    if (typeof body.script !== 'string') throw new Error('script (string) required');
    const wrapped = compileEvaluationScript(body.script);
    const raw = await withOperationTimeout(
      session.page.evaluate(wrapped),
      EVALUATE_TIMEOUT_MS,
      'Browser evaluation',
      () => closeSession(session.browserSessionId),
    );
    // Coerce to something JSON-serializable.
    let result;
    try { result = JSON.parse(JSON.stringify(raw === undefined ? null : raw)); }
    catch { result = String(raw); }
    return { ok: true, result };
  },

  'POST /shutdown': async () => {
    setImmediate(async () => {
      await shutdown();
      process.exit(0);
    });
    return { ok: true };
  },
};

const server = createServer(async (req, res) => {
  try {
    const supplied = Buffer.from(String(req.headers['x-atlas-worker-token'] ?? ''));
    const expected = Buffer.from(WORKER_TOKEN);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return send(res, 401, { ok: false, error: 'Invalid worker token' });
    }
    if (req.headers.origin) return send(res, 403, { ok: false, error: 'Browser origins are not allowed' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const handler = handlers[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { ok: false, error: `No handler for ${req.method} ${url.pathname}` });
    const body = req.method === 'POST' ? await readJson(req) : {};
    const query = Object.fromEntries(url.searchParams);
    send(res, 200, await handler(body, query));
  } catch (error) {
    send(res, 500, { ok: false, error: error?.message || String(error) });
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  console.log(`READY:${port}`);
});

// Exit when the parent goes away (stdin closes) or on termination signals.
process.stdin.on('end', () => { shutdown().finally(() => process.exit(0)); });
process.stdin.resume();
process.on('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
process.on('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
