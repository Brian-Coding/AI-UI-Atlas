// Real Atlas build and QA run, recorded in the actual viewer. No model calls.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAtlas } from '../src/atlas/atlas-runner';
import { WorkerBrowserDriver } from '../src/browser/worker-driver';
import { ScriptedProvider } from '../src/providers/scripted';
import { runQa } from '../src/qa/qa-runner';
import { createViewerApi } from '../src/server/viewer-api';
import { startServer } from '../src/server/server';
import viewer from '../src/viewer/index.html';
import scriptedAtlas from '../examples/demo-app/agents/scripted-atlas';
import scriptedQa from '../examples/demo-app/agents/scripted-qa';
import { startDemoServer } from '../examples/demo-app/server';
const root = await mkdtemp(join(tmpdir(), 'atlas-media-'));
const projectDir = join(root, 'acme-notes');
await mkdir(projectDir);
await cp(resolve(import.meta.dir, '../examples/demo-app/public'), join(projectDir, 'public'), { recursive: true });
await cp(resolve(import.meta.dir, '../examples/demo-app/server.ts'), join(projectDir, 'server.ts'));
const app = startDemoServer(0);
const driver = new WorkerBrowserDriver();
const url = `http://127.0.0.1:${app.port}`;
const server = startServer({ driver, staticRoutes: { '/': viewer }, routes: [createViewerApi({ projectDir })] });
let recorder: ReturnType<typeof Bun.spawn> | undefined;
try {
  const atlas = await buildAtlas({ projectDir, url, driver, provider: new ScriptedProvider(scriptedAtlas, 'scripted-demo') });
  assert.equal(atlas.status, 'completed');
  recorder = Bun.spawn(['node', resolve(import.meta.dir, 'record-media.mjs'), server.url, root], { stdout: 'inherit', stderr: 'inherit' });
  let started = false;
  for (let i = 0; i < 200; i++) { if (await Bun.file(join(root, 'start')).exists()) { started = true; break; } await Bun.sleep(100); }
  assert.ok(started, 'Recorder did not request QA');
  const qa = await runQa({ projectDir, url: `${url}/settings`, goal: 'Saving settings shows a confirmation', driver,
    provider: new ScriptedProvider(scriptedQa, 'scripted-demo') });
  assert.equal(qa.run.verdict, 'fail');
  assert.equal(qa.run.atlasUsed, true);
  await Bun.write(join(root, 'done'), qa.run.id);
  assert.equal(await recorder.exited, 0);
  console.log('PASS: recorded published map → actual scripted QA → failing verdict and captured evidence');
} finally {
  if (recorder && recorder.exitCode === null) { recorder.kill(); await recorder.exited; }
  await server.stop(); await driver.close(); app.stop(true);
  await rm(root, { recursive: true, force: true });
}
