import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDirs, projectWithAtlas, tempDir, writeAtlasBundle } from '../../tests/helpers';
import { FakeBrowserDriver } from '../browser/fake-driver';
import { ScriptedProvider } from '../providers/scripted';
import type { AgentProvider } from '../providers/types';
import { buildAtlas, discardAtlasRun, resumeAtlas } from './atlas-runner';
import { atlasCandidatePaths, validatePublishedAtlas } from './atlas-artifacts';

afterEach(cleanupTempDirs);
const complete = new ScriptedProvider(async ctx => { await writeAtlasBundle(ctx.runtime.outputDir!, ctx.runtime.runId!); return 'Complete'; });
function options(projectDir = tempDir()) {
  return { projectDir, url: 'http://app.test/', provider: complete, driver: new FakeBrowserDriver() };
}

test('publishes a complete bundle then validates it independently', async () => {
  const opts = options();
  const run = await buildAtlas(opts);
  expect(run).toMatchObject({ status: 'completed', surfaceCount: 3, entityCount: 3 });
  expect((await validatePublishedAtlas(opts.projectDir)).valid).toBe(true);
  expect(existsSync(atlasCandidatePaths(opts.projectDir, run.id).candidateRoot)).toBe(false);
});

test.each(['error', 'throw'])('Atlas redacts progress and saved provider %s', async mode => {
  const opts = options();
  let token = '';
  const progress: unknown[] = [];
  const provider: AgentProvider = { name: 'redaction-fixture', async run(task) {
    token = task.runtime.token!;
    const message = `token=${token}; Proxy-Authorization: Basic synthetic-auth-value`;
    task.onProgress?.({ type: 'tool', name: 'Bash', summary: message });
    task.onProgress?.({ type: 'text', text: message });
    task.onProgress?.({ type: 'status', message });
    if (mode === 'throw') throw new Error(message);
    return { finalText: '', exitCode: 1, timedOut: false, aborted: false, error: message };
  } };
  const run = await buildAtlas({ ...opts, provider, onProgress: event => progress.push(event) });
  expect(run.status).toBe('failed');
  const persisted = await readFile(join(opts.projectDir, '.atlas-qa/atlas-run.json'), 'utf8');
  for (const output of [JSON.stringify(progress), JSON.stringify(run), persisted]) {
    expect(output.includes(token)).toBe(false);
    expect(output.includes('synthetic-auth-value')).toBe(false);
    expect(output).toContain('<redacted-token>');
  }
});

test('invalid update preserves published bytes and can resume with the original model', async () => {
  const opts = options(await projectWithAtlas());
  const published = join(opts.projectDir, 'docs/ui-atlas/atlas.json');
  const before = await readFile(published, 'utf8');
  const failed = await buildAtlas({ ...opts, model: 'example-model', provider: new ScriptedProvider(() => 'Incomplete') });
  expect(failed.status).toBe('failed');
  expect(await readFile(published, 'utf8')).toBe(before);
  await expect(buildAtlas(opts)).rejects.toThrow('resumable candidate');
  let model: string | undefined;
  const provider: AgentProvider = { name: 'resume', run(task) { model = task.model; return complete.run(task); } };
  expect((await resumeAtlas({ ...opts, provider })).status).toBe('completed');
  expect(model).toBe('example-model');
});

test('failed or interrupted providers cannot publish even a structurally complete candidate', async () => {
  for (const interrupted of [false, true]) {
    const opts = options(await projectWithAtlas());
    const published = join(opts.projectDir, 'docs/ui-atlas/atlas.json');
    const before = await readFile(published, 'utf8');
    const provider: AgentProvider = { name: 'broken', async run(task) {
      return { ...await complete.run(task), exitCode: 1, aborted: interrupted, error: interrupted ? undefined : 'CLI failed' };
    } };
    const run = await buildAtlas({ ...opts, provider });
    expect(run.status).toBe(interrupted ? 'paused' : 'failed');
    expect(await readFile(published, 'utf8')).toBe(before);
    await discardAtlasRun(opts.projectDir);
    expect(await readFile(published, 'utf8')).toBe(before);
  }
});
