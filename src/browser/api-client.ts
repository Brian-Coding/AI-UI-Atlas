import type { BrowserStatus, ConsoleEntry, NetworkEntry } from './driver';

export interface ApiScreenshotOptions {
  name?: string;
  selector?: string;
  fullPage?: boolean;
  runId?: string;
}

/**
 * Minimal client for the HTTP browser API. This is exactly what an LLM agent
 * does with curl, wrapped for scripted agents, examples, and tests.
 */
export class BrowserApiClient {
  constructor(
    readonly apiBase: string,
    readonly token: string,
    readonly browserSessionId: string,
  ) {}

  private async request<T = any>(method: 'GET' | 'POST', endpoint: string, body?: Record<string, unknown>): Promise<T> {
    const url = method === 'GET'
      ? `${this.apiBase}/api/browser${endpoint}?browserSessionId=${encodeURIComponent(this.browserSessionId)}`
      : `${this.apiBase}/api/browser${endpoint}`;
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-atlas-qa-token': this.token },
      body: method === 'POST' ? JSON.stringify({ browserSessionId: this.browserSessionId, ...(body ?? {}) }) : undefined,
    });
    const json = await response.json().catch(() => ({})) as any;
    if (!response.ok || json?.ok === false) {
      throw new Error(`${method} ${endpoint} failed (${response.status}): ${json?.error ?? 'unknown error'}`);
    }
    return json as T;
  }

  navigate(url: string): Promise<{ url: string; title: string }> {
    return this.request('POST', '/navigate', { url });
  }

  async screenshot(options: ApiScreenshotOptions = {}): Promise<string> {
    return (await this.request<{ path: string }>('POST', '/screenshot', { ...options })).path;
  }

  async click(selector: string): Promise<void> {
    await this.request('POST', '/click', { selector });
  }

  async type(selector: string, text: string): Promise<void> {
    await this.request('POST', '/type', { selector, text });
  }

  async waitForReady(): Promise<void> {
    await this.request('POST', '/wait-for-ready', {});
  }

  async evaluate<T = unknown>(script: string): Promise<T> {
    return (await this.request<{ result: T }>('POST', '/evaluate', { script })).result;
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.request('POST', '/viewport', { width, height });
  }

  async console(): Promise<ConsoleEntry[]> {
    return (await this.request<{ entries: ConsoleEntry[] }>('GET', '/console')).entries;
  }

  async network(): Promise<NetworkEntry[]> {
    return (await this.request<{ entries: NetworkEntry[] }>('GET', '/network')).entries;
  }

  async clearConsole(): Promise<void> {
    await this.request('POST', '/console/clear', {});
  }

  async clearNetwork(): Promise<void> {
    await this.request('POST', '/network/clear', {});
  }

  status(): Promise<BrowserStatus & { ok: boolean }> {
    return this.request('GET', '/status');
  }
}
