/**
 * The contract between the HTTP browser API and whatever actually drives a
 * browser. The production implementation talks to the Node Playwright worker
 * (`WorkerBrowserDriver`); tests use `FakeBrowserDriver`.
 *
 * Every call is scoped to a browser session. Sessions are isolated browser
 * contexts (cookies, storage, console/network buffers), so a QA run and an
 * Atlas build never share page state.
 */

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'warning' | 'error' | 'debug' | string;
  text: string;
  timestamp: number;
}

export interface NetworkEntry {
  kind: 'response' | 'requestfailed';
  url: string;
  method: string;
  status: number | null;
  ok: boolean;
  error?: string;
  timestamp: number;
}

export interface BrowserStatus {
  running: boolean;
  url?: string;
  title?: string;
  browserSessionId?: string;
}

export interface ScreenshotRequest {
  /** Absolute directory chosen by the server; never by the agent. */
  outDir: string;
  name?: string;
  selector?: string;
  fullPage?: boolean;
}

export interface RunEvidence {
  complete: boolean;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  screenshots: Array<{ path: string; sha256: string }>;
}

export interface BrowserDriver {
  /** Harness-only journal: never exposed by the agent HTTP API. */
  beginEvidence(sessionId: string): Promise<void>;
  readEvidence(sessionId: string): Promise<RunEvidence>;
  endEvidence(sessionId: string): Promise<void>;
  navigate(sessionId: string, url: string): Promise<{ url: string; title: string }>;
  screenshot(sessionId: string, request: ScreenshotRequest): Promise<string>;
  click(sessionId: string, selector: string): Promise<void>;
  type(sessionId: string, selector: string, text: string): Promise<void>;
  waitForReady(sessionId: string): Promise<{ duration: number }>;
  evaluate(sessionId: string, script: string): Promise<unknown>;
  setViewport(sessionId: string, width: number, height: number): Promise<void>;
  getConsole(sessionId: string): Promise<ConsoleEntry[]>;
  clearConsole(sessionId: string): Promise<void>;
  getNetwork(sessionId: string): Promise<NetworkEntry[]>;
  clearNetwork(sessionId: string): Promise<void>;
  status(sessionId: string): Promise<BrowserStatus>;
  closeSession(sessionId: string): Promise<void>;
  /** Release every browser resource (worker process, Chromium). */
  close(): Promise<void>;
}

export function isConsoleError(entry: ConsoleEntry): boolean {
  return entry.level === 'error';
}

export function isConsoleWarning(entry: ConsoleEntry): boolean {
  return entry.level === 'warn' || entry.level === 'warning';
}
