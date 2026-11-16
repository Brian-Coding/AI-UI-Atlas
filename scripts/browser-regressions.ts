import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerBrowserDriver } from '../src/browser/worker-driver';
import { BrowserApiClient } from '../src/browser/api-client';
import { ScriptedProvider } from '../src/providers/scripted';
import { runQa } from '../src/qa/qa-runner';
import { QA_RESULT_START, QA_RESULT_END } from '../src/qa/qa-result';
import { startServer } from '../src/server/server';
import { createViewerApi } from '../src/server/viewer-api';
import { writeAtlasBundle } from '../tests/helpers';
import { ATLAS_ANSWER_START, ATLAS_ANSWER_END } from '../src/atlas/atlas-query-result';

const root = await mkdtemp(join(tmpdir(), 'atlas-browser-regressions-'));
const driver = new WorkerBrowserDriver();
const app = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => new URL(req.url).pathname === '/failure'
  ? new Response('failure', { status: 500 }) : new Response('<!doctype html><title>Acme Notes</title><h1>Demo notes</h1>', { headers: { 'content-type': 'text/html' } }) });
let viewer: ReturnType<typeof startServer> | undefined;
let foreign: ReturnType<typeof Bun.serve> | undefined;
try {
  for (const mode of ['clear', 'view-overflow', 'journal-overflow', 'replace-session', 'tamper', 'signature-only']) {
    const provider = new ScriptedProvider(async ctx => {
      const browser = ctx.browser!;
      await browser.navigate(ctx.runtime.targetUrl!);
      const shot = await browser.screenshot({ name: 'evidence' });
      if (!['tamper', 'signature-only'].includes(mode)) {
        await browser.evaluate("await fetch('/failure'); console.error('Scoped failure');");
        if (mode === 'clear') { await browser.clearConsole(); await browser.clearNetwork(); }
        if (mode.includes('overflow')) await browser.evaluate(`for(let i=0;i<${mode === 'view-overflow' ? 350 : 10_050};i++) console.log('entry '+i)`);
        if (mode === 'replace-session') { await browser.closeSession(); await browser.navigate(ctx.runtime.targetUrl!); }
      } else if (mode === 'signature-only') await writeFile(shot, Buffer.from([137,80,78,71,13,10,26,10]));
      else { const bytes = await readFile(shot); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await writeFile(shot, bytes); }
      return `${QA_RESULT_START}\n${JSON.stringify({ schemaVersion: 1, runId: ctx.runtime.runId, verdict: 'pass', summary: 'Agent claims success.',
        assertions: [{ id: 'assert.demo', name: 'Demo renders', status: 'passed', evidenceIds: ['evidence.demo'] }], findings: [],
        evidence: [{ id: 'evidence.demo', kind: 'screenshot', label: 'Demo', ref: shot }, { id: 'evidence.console', kind: 'console', label: 'Console', detail: 'Agent claims clean' }],
      })}\n${QA_RESULT_END}`;
    });
    const { run } = await runQa({ projectDir: root, url: `http://127.0.0.1:${app.port}`, goal: 'Render demo', driver, provider });
    const expected = ['clear', 'view-overflow'].includes(mode) ? 'fail' : 'inconclusive';
    assert.equal(run.verdict, expected, mode);
    await assert.rejects(driver.readEvidence(run.browserSessionId), /No run evidence journal/);
  }
  console.log('PASS: runQa retains cleared/evicted failures and rejects journal loss, overflow, replaced sessions, and altered screenshots');

  await writeAtlasBundle(join(root, 'docs/ui-atlas'));
  let asks = 0;
  viewer = startServer({ driver, staticRoutes: { '/': new Response('<!doctype html><title>Atlas test</title>') }, routes: [createViewerApi({ projectDir: root,
    askProvider: async () => new ScriptedProvider(() => { asks++; return `${ATLAS_ANSWER_START}\n{"answer":"See surface.notes-list.","citations":["surface.notes-list"]}\n${ATLAS_ANSWER_END}`; }),
  })] });
  const shots = join(root, 'shots'); await mkdir(shots);
  const outside = join(root, 'outside.txt'); await writeFile(outside, 'unchanged');
  await symlink(outside, join(shots, 'escape.png'));
  viewer.sessions.register({ sessionId: 'symlink-test', kind: 'qa', runId: 'symlink-test', screenshotDir: shots });
  const client = new BrowserApiClient(viewer.url, viewer.token, 'symlink-test');
  await client.navigate(`http://127.0.0.1:${app.port}`);
  await assert.rejects(client.screenshot({ name: 'escape' }));
  assert.equal(await readFile(outside, 'utf8'), 'unchanged');
  const linked = join(root, 'linked'); await symlink(shots, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(driver.screenshot('symlink-test', { outDir: linked, name: 'ancestor' }));
  const first = await client.screenshot({ name: 'exclusive' });
  await assert.rejects(client.screenshot({ name: 'exclusive' }));
  assert.ok((await readFile(first)).length > 8);
  console.log('PASS: real screenshot driver rejects filename and ancestor links and refuses overwrites');

  foreign = Bun.serve({ hostname: '::1', port: viewer.port, reusePort: false, fetch: () => new Response('<!doctype html><title>Other origin</title>') });
  await driver.navigate('csrf-test', `http://[::1]:${viewer.port}`);
  await driver.evaluate('csrf-test', `await fetch(${JSON.stringify(viewer.url + '/api/atlas/ask')}, { method:'POST', mode:'no-cors', headers:{'content-type':'text/plain'}, body:JSON.stringify({question:'Notes?'}) }).catch(()=>{});`);
  assert.equal(asks, 0, 'IPv6 origin must not trigger IPv4 Ask');
  await driver.navigate('csrf-test', viewer.url);
  assert.equal(await driver.evaluate('csrf-test', "return (await fetch('/api/atlas/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question:'Notes?'})})).status"), 403);
  assert.equal(await driver.evaluate('csrf-test', "const p=await (await fetch('/api/project')).json(); return (await fetch('/api/atlas/ask',{method:'POST',headers:{'content-type':'application/json','x-atlas-csrf':p.csrfToken},body:JSON.stringify({question:'Notes?'})})).status"), 200);
  assert.equal(asks, 1);
  console.log('PASS: real browser blocks IPv6-to-IPv4 Ask and allows same-origin Ask only with its launch token');
} finally {
  if (foreign) await foreign.stop(true);
  if (viewer) await viewer.stop();
  await driver.close(); await app.stop(true);
  await rm(root, { recursive: true, force: true });
}
