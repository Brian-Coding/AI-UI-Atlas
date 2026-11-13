import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeBrowserDriver } from '../browser/fake-driver';
import { cleanupTempDirs, tempDir } from '../../tests/helpers';
import type { BrowserApiEvent } from './browser-api';
import { startServer, type RunningServer } from './server';

let driver: FakeBrowserDriver;
let server: RunningServer;
let adhoc: string;
const events: BrowserApiEvent[] = [];

function call(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${server.url}/api/browser${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-qa-token': server.token, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeAll(() => {
  driver = new FakeBrowserDriver({
    'http://app.test/': { title: 'Home', console: [{ level: 'warning', text: 'deprecated api' }] },
  });
  adhoc = tempDir('adhoc');
  server = startServer({ driver, adhocScreenshotRoot: adhoc, onBrowserEvent: event => events.push(event) });
});

afterAll(async () => {
  await server.stop();
  cleanupTempDirs();
});

afterEach(() => { events.length = 0; });

describe('browser API', () => {
  test('requires the per-server token', async () => {
    const missing = await fetch(`${server.url}/api/browser/status?browserSessionId=a`);
    expect(missing.status).toBe(401);
    const wrong = await call('/status?browserSessionId=a', undefined, { 'x-atlas-qa-token': 'nope' });
    expect(wrong.status).toBe(401);
    const bearer = await fetch(`${server.url}/api/browser/status?browserSessionId=a`, { headers: { authorization: `Bearer ${server.token}` } });
    expect(bearer.status).toBe(200);
  });

  test('refuses cross-origin and rebinding requests before routing', async () => {
    const crossOrigin = await call('/status', undefined, { origin: 'http://localhost:3000' });
    expect(crossOrigin.status).toBe(403);
  });

  test('refuses to bind a non-loopback interface', () => {
    expect(() => startServer({ driver, hostname: '0.0.0.0' })).toThrow('loopback-only');
  });

  test('navigates, reports status, console, and network for a session', async () => {
    const nav = await call('/navigate', { browserSessionId: 'qa-one', url: 'http://app.test/' });
    expect(nav.status).toBe(200);
    expect(await nav.json()).toMatchObject({ ok: true, title: 'Home' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'call', endpoint: 'navigate', sessionId: 'qa-one' }));

    expect(await (await call('/status?browserSessionId=qa-one')).json()).toMatchObject({ running: true, title: 'Home' });
    const consoleEntries = (await (await call('/console?browserSessionId=qa-one')).json()).entries;
    expect(consoleEntries[0].text).toBe('deprecated api');
    expect((await (await call('/network?browserSessionId=qa-one')).json()).entries[0].status).toBe(200);

    await call('/console/clear', { browserSessionId: 'qa-one' });
    await call('/network/clear', { browserSessionId: 'qa-one' });
    expect((await (await call('/console?browserSessionId=qa-one')).json()).entries).toEqual([]);
    expect((await (await call('/network?browserSessionId=qa-one')).json()).entries).toEqual([]);

    // Sessions are isolated.
    expect(await (await call('/status?browserSessionId=other')).json()).toMatchObject({ running: false });
  });

  test('forwards interactions with validation', async () => {
    expect((await call('/click', { browserSessionId: 's', selector: '#save' })).status).toBe(200);
    expect((await call('/type', { browserSessionId: 's', selector: '#name', text: 'Sam' })).status).toBe(200);
    expect((await call('/wait-for-ready', { browserSessionId: 's' })).status).toBe(200);
    expect((await call('/evaluate', { browserSessionId: 's', script: '1 + 1' })).status).toBe(200);
    expect((await call('/viewport', { browserSessionId: 's', width: 390, height: 844 })).status).toBe(200);
    expect((await call('/session/close', { browserSessionId: 's' })).status).toBe(200);
    expect((await call('/context/close', { browserSessionId: 's' })).status).toBe(200);
    expect(driver.calls.filter(c => c.sessionId === 's').map(c => c.op)).toEqual([
      'click', 'type', 'wait-for-ready', 'evaluate', 'viewport', 'close-session', 'close-session',
    ]);

    expect((await (await call('/click', { browserSessionId: 's' })).json()).error).toBe('selector required');
    expect((await (await call('/type', { browserSessionId: 's', selector: 'x' })).json()).error).toBe('text required');
    expect((await (await call('/evaluate', { browserSessionId: 's', script: '' })).json()).error).toBe('script required');
    expect((await (await call('/viewport', { browserSessionId: 's', width: 1, height: 800 })).json()).error).toContain('width');
    expect((await (await call('/viewport', { browserSessionId: 's', width: 800, height: 99999 })).json()).error).toContain('height');
  });

  test('rejects unsafe session IDs and URL schemes', async () => {
    const badSession = await call('/navigate', { browserSessionId: '../escape', url: 'http://app.test/' });
    expect(badSession.status).toBe(400);
    expect((await badSession.json()).error).toBe('invalid browserSessionId');
    const fileUrl = await call('/navigate', { browserSessionId: 's', url: 'file:///etc/hostname' });
    expect(fileUrl.status).toBe(400);
    expect((await fileUrl.json()).error).toContain('not allowed');
    const relative = await call('/navigate', { browserSessionId: 's', url: '/relative' });
    expect((await relative.json()).error).toContain('absolute URL');
  });

  test('preserves malformed, oversized, and non-object body errors', async () => {
    const malformed = await call('/navigate', '{broken');
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toContain('valid JSON');
    const oversized = await call('/click', { browserSessionId: 's', selector: 'x'.repeat(1024 * 1024) });
    expect(oversized.status).toBe(413);
    const array = await call('/click', '[1,2]');
    expect((await array.json()).error).toContain('JSON object');
  });

  test('writes screenshots only into the session\'s granted directory', async () => {
    const runDir = tempDir('grant');
    const shots = join(runDir, 'screenshots');
    server.sessions.register({ sessionId: 'qa-granted', kind: 'qa', screenshotDir: shots, runId: 'run-1' });

    const ok = await call('/screenshot', { browserSessionId: 'qa-granted', runId: 'run-1', name: 'landing' });
    const okBody = await ok.json();
    expect(ok.status).toBe(200);
    expect(okBody.path).toBe(join(shots, 'landing.png'));
    expect(existsSync(okBody.path)).toBe(true);
    expect(events).toContainEqual({ type: 'screenshot', sessionId: 'qa-granted', path: okBody.path });

    const nested = await call('/screenshot', { browserSessionId: 'qa-granted', outDir: join(shots, 'mobile'), name: 'm' });
    expect((await nested.json()).path).toBe(join(shots, 'mobile', 'm.png'));

    const escape = await call('/screenshot', { browserSessionId: 'qa-granted', outDir: runDir });
    expect(escape.status).toBe(403);
    const otherRun = await call('/screenshot', { browserSessionId: 'qa-granted', runId: 'run-2' });
    expect(otherRun.status).toBe(403);
    const badRun = await call('/screenshot', { browserSessionId: 'qa-granted', runId: '../x' });
    expect((await badRun.json()).error).toBe('invalid runId');
    const traversalName = await call('/screenshot', { browserSessionId: 'qa-granted', name: '../../outside' });
    expect((await traversalName.json()).path.startsWith(shots)).toBe(true);

    server.sessions.unregister('qa-granted');
  });

  test('rejects a new screenshot directory below an existing symlink', async () => {
    const root = tempDir('confined');
    const outside = tempDir('outside');
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    server.sessions.register({ sessionId: 'qa-linked', kind: 'qa', screenshotDir: root });
    const result = await call('/screenshot', { browserSessionId: 'qa-linked', outDir: join(root, 'escape', 'new-dir') });
    expect(result.status).toBe(403);
    expect(existsSync(join(outside, 'new-dir'))).toBe(false);
    server.sessions.unregister('qa-linked');
  });

  test('ad-hoc sessions get a per-session folder under the data dir', async () => {
    const response = await call('/screenshot', { browserSessionId: 'adhoc-1', name: 'x' });
    expect((await response.json()).path).toBe(join(adhoc, 'adhoc-1', 'x.png'));
  });

  test('emits one stuck warning per streak of identical calls', async () => {
    for (let i = 0; i < 7; i++) await call('/click', { browserSessionId: 'loop', selector: '#nothing' });
    expect(events.filter(event => event.type === 'stuck')).toEqual([
      expect.objectContaining({ type: 'stuck', sessionId: 'loop', endpoint: 'click', repeatCount: 5 }),
    ]);
  });

  test('driver failures become 500s and unknown endpoints 404', async () => {
    const strict = new FakeBrowserDriver({ 'http://app.test/': { selectors: ['#ok'] } });
    const strictServer = startServer({ driver: strict, token: 'fixed' });
    try {
      const headers = { 'content-type': 'application/json', 'x-atlas-qa-token': 'fixed' };
      await fetch(`${strictServer.url}/api/browser/navigate`, { method: 'POST', headers, body: JSON.stringify({ browserSessionId: 'x', url: 'http://app.test/' }) });
      const failed = await fetch(`${strictServer.url}/api/browser/click`, { method: 'POST', headers, body: JSON.stringify({ browserSessionId: 'x', selector: '#missing' }) });
      expect(failed.status).toBe(500);
      expect((await failed.json()).error).toContain('#missing');
      const unknown = await fetch(`${strictServer.url}/api/browser/teleport`, { method: 'POST', headers, body: '{}' });
      expect(unknown.status).toBe(404);
    } finally {
      await strictServer.stop();
    }
  });
});
