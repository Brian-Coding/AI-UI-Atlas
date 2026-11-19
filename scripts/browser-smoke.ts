// Real Chromium acceptance test. No provider accounts, external app, or LLM calls.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAtlas } from '../src/atlas/atlas-runner';
import { loadPublishedAtlas, queryAtlas } from '../src/atlas/atlas-search';
import { createAtlasCandidate, promoteAtlasCandidate, validateAtlasCandidate, validatePublishedAtlas } from '../src/atlas/atlas-artifacts';
import { WorkerBrowserDriver } from '../src/browser/worker-driver';
import { ScriptedProvider } from '../src/providers/scripted';
import { runQa } from '../src/qa/qa-runner';
import { readSurfaceVerifications } from '../src/atlas/verifications';
import { createViewerApi } from '../src/server/viewer-api';
import { startServer, type RunningServer } from '../src/server/server';
import viewer from '../src/viewer/index.html';
import scriptedAtlas from '../examples/demo-app/agents/scripted-atlas';
import scriptedQa from '../examples/demo-app/agents/scripted-qa';
import { startDemoServer } from '../examples/demo-app/server';

const tempRoot = await mkdtemp(join(tmpdir(), 'atlas-qa-browser-'));
const projectDir = join(tempRoot, 'acme-notes');
const app = startDemoServer(0);
const url = `http://127.0.0.1:${app.port}`;
const driver = new WorkerBrowserDriver();
let server: RunningServer | undefined;
try {
  await mkdir(projectDir);
  await cp(resolve(import.meta.dir, '../examples/demo-app/server.ts'), join(projectDir, 'server.ts'));
  await cp(resolve(import.meta.dir, '../examples/demo-app/public'), join(projectDir, 'public'), { recursive: true });
  const atlas = await buildAtlas({ projectDir, url, driver, provider: new ScriptedProvider(scriptedAtlas) });
  assert.equal(atlas.status, 'completed');
  assert.equal(atlas.surfaceCount, 5);
  assert.equal((await validatePublishedAtlas(projectDir)).valid, true);
  const { graph } = await loadPublishedAtlas(projectDir);
  assert.equal(queryAtlas(graph, 'where are tags shown?').intent, 'entity-surfaces');
  console.log('PASS: built and queried five real app surfaces with Chromium screenshots');

  // A malformed model response must not replace the Atlas used by the viewer below.
  const malformed = await createAtlasCandidate(projectDir, 'malformed-actions');
  await cp(malformed.canonicalRoot, malformed.candidateRoot, { recursive: true });
  for (const name of ['atlas.json', 'manifest.json', 'checkpoint.json']) {
    const path = join(malformed.candidateRoot, name);
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.runId = 'malformed-actions';
    if (name === 'atlas.json') record.surfaces[0].actions = 'Search notes';
    await writeFile(path, JSON.stringify(record));
  }
  assert.equal((await validateAtlasCandidate(projectDir, 'malformed-actions')).valid, false);
  await assert.rejects(promoteAtlasCandidate(projectDir, 'malformed-actions'), /actions must be an array of strings/);
  assert.equal((await validatePublishedAtlas(projectDir)).valid, true);
  assert.deepEqual((await loadPublishedAtlas(projectDir)).graph, graph);

  const common = { projectDir, driver, provider: new ScriptedProvider(scriptedQa) };
  const good = await runQa({ ...common, url, goal: 'Browse notes and open a note' });
  assert.equal(good.run.verdict, 'pass');
  assert.equal(good.run.atlasUsed, true);
  assert.ok((await readSurfaceVerifications(projectDir))['surface.notes-list']);
  const broken = await runQa({ ...common, url: `${url}/settings`, goal: 'Saving settings shows a confirmation' });
  assert.equal(broken.run.verdict, 'fail');
  assert.equal(broken.run.status, 'completed');
  assert.ok(broken.run.findings?.some(f => f.id === 'finding.harness-runtime'));
  console.log('PASS: clean flow passes; intentional HTTP 500 fails with corroborated evidence');

  // Even when the port is discovered, callers cannot bypass the Bun API.
  const workerPort = Reflect.get(driver, 'port');
  assert.equal((await fetch(`http://127.0.0.1:${workerPort}/status`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${workerPort}/shutdown`, { method: 'POST' })).status, 401);

  server = startServer({ driver, staticRoutes: { '/': viewer }, routes: [createViewerApi({ projectDir })] });
  assert.equal((await fetch(`${server.url}/api/project`, { headers: { origin: url } })).status, 403);
  const session = 'viewer-smoke';
  await driver.navigate(session, server.url);
  await driver.waitForReady(session);
  for (let i = 0; i < 40; i++) {
    if (await driver.evaluate(session, "document.querySelector('.card .num')?.textContent === '5'")) break;
    await Bun.sleep(100);
  }
  assert.equal(await driver.evaluate(session, "document.querySelector('.card .num')?.textContent"), '5');
  await driver.click(session, 'button.tab:text-is("Surfaces")');
  await driver.waitForReady(session);
  await driver.type(session, '[aria-label="Filter records"]', 'settings');
  assert.equal(await driver.evaluate(session, "document.querySelectorAll('.list-item').length"), 1);
  assert.ok(String(await driver.evaluate(session, "document.querySelector('.detail h2')?.textContent")).includes('Settings'));
  assert.equal(await driver.evaluate(session, "Array.from(document.querySelectorAll('img')).every(img => img.complete && img.naturalWidth > 0)"), true);
  if (process.env.ATLAS_QA_CAPTURE_PREVIEW === '1') {
    await rm(resolve(import.meta.dir, '../docs/images/atlas-viewer.png'), { force: true });
    await driver.screenshot(session, { outDir: resolve(import.meta.dir, '../docs/images'), name: 'atlas-viewer' });
  }
  await driver.click(session, 'button.tab:text-is("Ask Atlas")');
  for (const width of [1440, 390]) {
    await driver.setViewport(session, width, 900);
    assert.deepEqual(await driver.evaluate(session, `Array.from(document.querySelectorAll('main .btn')).map(button => {
      const range = document.createRange(); range.selectNodeContents(button);
      return range.getClientRects().length;
    })`), [1, 1], `Ask buttons must stay single-line at ${width}px`);
    assert.equal(await driver.evaluate(session, 'document.documentElement.scrollWidth <= window.innerWidth'), true);
  }
  assert.ok(String(await driver.evaluate(session, "document.querySelector('main .meta')?.textContent")).includes('--allow-ask'));
  assert.equal(await driver.evaluate(session, "Array.from(document.querySelectorAll('main button')).find(b => b.textContent.trim() === 'Ask LLM')?.disabled"), true);
  console.log('PASS: Ask labels stay single-line at 1440px and 390px, with a visible disabled-Ask hint');
  await driver.type(session, '[aria-label="Ask Atlas"]', 'where are tags shown?');
  await driver.click(session, 'button:text-is("Search atlas")');
  await driver.waitForReady(session);
  assert.ok(String(await driver.evaluate(session, "document.querySelector('main')?.textContent")).includes('shown on'));
  await driver.click(session, 'button.tab:text-is("QA runs")');
  await driver.waitForReady(session);
  await driver.click(session, 'button.run-link:text-is("Saving settings shows a confirmation")');
  await driver.waitForReady(session);
  assert.ok(String(await driver.evaluate(session, "document.querySelector('main')?.textContent")).includes('Runtime errors'));
  assert.equal(await driver.evaluate(session, "Array.from(document.querySelectorAll('img')).every(img => img.complete && img.naturalWidth > 0)"), true);
  const download = await fetch(`${server.url}/api/qa/runs/${broken.run.id}/report`);
  assert.ok((await download.text()).includes('settings-after-save.png'));
  await driver.setViewport(session, 390, 844);
  await driver.waitForReady(session);
  assert.equal(await driver.evaluate(session, 'document.documentElement.scrollWidth <= window.innerWidth'), true);
  assert.equal((await driver.getConsole(session)).filter(e => e.level === 'error').length, 0);
  console.log('PASS: after malformed publication is rejected, viewer renders the previous Atlas, filters, searches, displays reports and screenshots, and fits mobile');
} finally {
  await server?.stop();
  await driver.close();
  app.stop(true);
  await rm(tempRoot, { recursive: true, force: true });
}
