import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { screenshotFileName } from '../../scripts/browser-worker-core.mjs';
import type {
  BrowserDriver,
  RunEvidence,
  BrowserStatus,
  ConsoleEntry,
  NetworkEntry,
  ScreenshotRequest,
} from './driver';

/** A valid 1x1 PNG, so screenshot evidence passes signature checks. */
export const TINY_PNG = PNG.sync.write({ width: 1, height: 1, data: Buffer.from([80, 130, 220, 255]) } as PNG);

export interface FakePage {
  title?: string;
  /** Console entries emitted when the page is navigated to. */
  console?: Array<Pick<ConsoleEntry, 'level' | 'text'>>;
  /** Network entries recorded when the page is navigated to. */
  network?: Array<Omit<NetworkEntry, 'timestamp'>>;
  /** Selectors that exist on the page. Clicking anything else fails. */
  selectors?: string[];
}

export interface FakeBrowserCall {
  op: string;
  sessionId: string;
  args: Record<string, unknown>;
}

interface FakeSession {
  url: string;
  title: string;
  console: ConsoleEntry[];
  network: NetworkEntry[];
}

/**
 * Deterministic in-memory browser used by tests and by contributors who want
 * to exercise the HTTP API without Chromium. Screenshots are real (tiny) PNG
 * files written to the requested directory.
 */
export class FakeBrowserDriver implements BrowserDriver {
  readonly calls: FakeBrowserCall[] = [];
  private readonly sessions = new Map<string, FakeSession>();
  closed = false;
  private readonly evidence = new Map<string, RunEvidence>();
  async beginEvidence(id: string): Promise<void> {
    this.session(id);
    this.evidence.set(id, { complete: true, console: [], network: [], screenshots: [] });
  }
  async endEvidence(id: string): Promise<void> { this.evidence.delete(id); }
  async readEvidence(id: string): Promise<RunEvidence> {
    const journal = this.evidence.get(id);
    if (!journal) throw new Error('No run evidence journal');
    const session = this.sessions.get(id);
    return structuredClone({ ...journal,
      console: [...journal.console, ...(session?.console ?? [])],
      network: [...journal.network, ...(session?.network ?? [])] });
  }

  constructor(
    private readonly pages: Record<string, FakePage> = {},
    private readonly evaluator: (script: string, sessionId: string) => unknown = () => null,
  ) {}

  private session(sessionId: string): FakeSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { url: 'about:blank', title: '', console: [], network: [] };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private record(op: string, sessionId: string, args: Record<string, unknown> = {}): void {
    this.calls.push({ op, sessionId, args });
  }

  async navigate(sessionId: string, url: string): Promise<{ url: string; title: string }> {
    this.record('navigate', sessionId, { url });
    const session = this.session(sessionId);
    const page = this.pages[url];
    session.url = url;
    session.title = page?.title ?? '';
    const now = Date.now();
    for (const entry of page?.console ?? []) session.console.push({ ...entry, timestamp: now });
    session.network.push({ kind: 'response', url, method: 'GET', status: page ? 200 : 404, ok: !!page, timestamp: now });
    for (const entry of page?.network ?? []) session.network.push({ ...entry, timestamp: now });
    return { url, title: session.title };
  }

  async screenshot(sessionId: string, request: ScreenshotRequest): Promise<string> {
    this.record('screenshot', sessionId, { ...request });
    this.session(sessionId);
    await mkdir(request.outDir, { recursive: true });
    const path = join(request.outDir, screenshotFileName(request.name));
    await writeFile(path, TINY_PNG, { flag: 'wx' });
    this.evidence.get(sessionId)?.screenshots.push({ path, sha256: createHash('sha256').update(TINY_PNG).digest('hex') });
    return path;
  }

  async click(sessionId: string, selector: string): Promise<void> {
    this.record('click', sessionId, { selector });
    const page = this.pages[this.session(sessionId).url];
    if (page?.selectors && !page.selectors.includes(selector)) {
      throw new Error(`Timeout waiting for selector ${selector}`);
    }
  }

  async type(sessionId: string, selector: string, text: string): Promise<void> {
    this.record('type', sessionId, { selector, text });
  }

  async waitForReady(sessionId: string): Promise<{ duration: number }> {
    this.record('wait-for-ready', sessionId);
    this.session(sessionId);
    return { duration: 0 };
  }

  async evaluate(sessionId: string, script: string): Promise<unknown> {
    this.record('evaluate', sessionId, { script });
    return this.evaluator(script, sessionId);
  }

  async setViewport(sessionId: string, width: number, height: number): Promise<void> {
    this.record('viewport', sessionId, { width, height });
  }

  async getConsole(sessionId: string): Promise<ConsoleEntry[]> {
    return [...(this.sessions.get(sessionId)?.console ?? [])];
  }

  async clearConsole(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) { this.evidence.get(sessionId)?.console.push(...session.console); session.console = []; }
  }

  async getNetwork(sessionId: string): Promise<NetworkEntry[]> {
    return [...(this.sessions.get(sessionId)?.network ?? [])];
  }

  async clearNetwork(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) { this.evidence.get(sessionId)?.network.push(...session.network); session.network = []; }
  }

  async status(sessionId: string): Promise<BrowserStatus> {
    const session = this.sessions.get(sessionId);
    if (!session) return { running: false };
    return { running: true, url: session.url, title: session.title, browserSessionId: sessionId };
  }

  async closeSession(sessionId: string): Promise<void> {
    this.record('close-session', sessionId);
    const journal = this.evidence.get(sessionId);
    if (journal) journal.complete = false;
    this.sessions.delete(sessionId);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.sessions.clear();
  }
}
