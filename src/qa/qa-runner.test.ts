import { afterEach, expect, test } from 'bun:test';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDirs, projectWithAtlas, tempDir } from '../../tests/helpers';
import { FakeBrowserDriver } from '../browser/fake-driver';
import { readSurfaceVerifications } from '../atlas/verifications';
import { ScriptedProvider } from '../providers/scripted';
import type { AgentProvider, ScriptedAgentContext } from '../providers/types';
import { QA_RESULT_START, QA_RESULT_END } from './qa-result';
import { exitCodeForRun, runQa } from './qa-runner';

afterEach(cleanupTempDirs);

async function passing(ctx: ScriptedAgentContext): Promise<string> {
  await ctx.browser!.navigate(ctx.runtime.targetUrl!);
  const path = await ctx.browser!.screenshot({ name: 'landing' });
  return `${QA_RESULT_START}\n${JSON.stringify({
    schemaVersion: 1, runId: ctx.runtime.runId, verdict: 'pass', summary: 'Notes are visible.',
    assertions: [{ id: 'assert.notes', name: 'Notes are visible', status: 'passed', evidenceIds: ['evidence.shot'], atlasSurfaceIds: ['surface.notes-list'] }],
    findings: [], evidence: [
      { id: 'evidence.shot', kind: 'screenshot', label: 'Notes list', ref: path },
      { id: 'evidence.console', kind: 'console', label: 'Console', detail: 'No errors' },
    ],
  })}\n${QA_RESULT_END}`;
}

function options(projectDir = tempDir()) {
  return { projectDir, url: 'http://app.test/', goal: 'Check notes', driver: new FakeBrowserDriver({ 'http://app.test/': {} }), provider: new ScriptedProvider(passing) };
}

test('a full QA run writes reports, redacts the token, records Atlas verification and closes its session', async () => {
  const opts = options(await projectWithAtlas());
  let token = '';
  opts.provider = new ScriptedProvider(async ctx => { token = ctx.runtime.token!; return passing(ctx); });
  const outcome = await runQa(opts);
  expect(outcome.run).toMatchObject({ status: 'completed', verdict: 'pass', atlasUsed: true });
  expect(exitCodeForRun(outcome.run)).toBe(0);
  expect(await readFile(outcome.reportPath, 'utf8')).toContain('screenshots/landing.png');
  expect(await readFile(join(outcome.runDir, 'system-prompt.md'), 'utf8')).not.toContain(token);
  expect((await readSurfaceVerifications(opts.projectDir))['surface.notes-list']?.runId).toBe(outcome.run.id);
  expect((await opts.driver.status(outcome.run.browserSessionId)).running).toBe(false);
  expect(opts.driver.closed).toBe(false); // An injected driver belongs to the caller.
});

test('harness console errors override an agent PASS', async () => {
  const opts = options();
  opts.driver = new FakeBrowserDriver({ 'http://app.test/': { console: [{ level: 'error', text: 'Save failed' }] } });
  const { run } = await runQa(opts);
  expect(run).toMatchObject({ status: 'completed', verdict: 'fail' });
  expect(run.findings?.some(f => f.id === 'finding.harness-runtime')).toBe(true);
  expect(exitCodeForRun(run)).toBe(1);
});

test.each(['console', 'network', 'incomplete', 'screenshot', 'healthy'] as const)(
  'final validation uses one snapshot for %s evidence without live reads', async kind => {
    const opts = options(await projectWithAtlas());
    const finalize = opts.driver.finalizeEvidence.bind(opts.driver);
    let finalizations = 0;
    opts.driver.readEvidence = async () => { throw new Error('Unexpected live journal read'); };
    opts.driver.finalizeEvidence = async id => {
      finalizations++;
      const snapshot = await finalize(id);
      if (kind === 'console') snapshot.console.push({ level: 'error', text: 'Late error', timestamp: Date.now() });
      if (kind === 'network') snapshot.network.push({ kind: 'response', method: 'GET', url: opts.url, status: 500, ok: false, timestamp: Date.now() });
      if (kind === 'incomplete') snapshot.complete = false;
      if (kind === 'screenshot') snapshot.screenshots = [];
      return snapshot;
    };
    const { run } = await runQa(opts);
    expect(finalizations).toBe(1);
    const expected = kind === 'healthy' ? 'pass' : ['console', 'network'].includes(kind) ? 'fail' : 'inconclusive';
    expect(run.verdict).toBe(expected);
    expect(exitCodeForRun(run)).toBe(expected === 'pass' ? 0 : expected === 'fail' ? 1 : 2);
    const verifications = await readSurfaceVerifications(opts.projectDir);
    if (kind === 'healthy') expect(verifications['surface.notes-list']?.runId).toBe(run.id);
    else expect(verifications).toEqual({});
  },
);

test('fake evidence finalization is idempotent and survives later events and cleanup', async () => {
  const driver = new FakeBrowserDriver({ 'http://app.test/': { console: [{ level: 'error', text: 'After cutoff' }] } });
  await expect(driver.finalizeEvidence('missing')).rejects.toThrow('No run evidence journal');
  await driver.beginEvidence('fixture');
  const frozen = await driver.finalizeEvidence('fixture');
  expect(frozen.complete).toBe(true);
  expect(frozen.finalizedAt).toBeTruthy();
  await driver.navigate('fixture', 'http://app.test/');
  await driver.screenshot('fixture', { outDir: tempDir(), name: 'late' });
  await driver.clearConsole('fixture');
  await driver.clearNetwork('fixture');
  await driver.closeSession('fixture');
  expect(await driver.readEvidence('fixture')).toEqual(frozen);
  const returned = await driver.finalizeEvidence('fixture');
  returned.complete = false;
  expect(await driver.finalizeEvidence('fixture')).toEqual(frozen);
  await driver.endEvidence('fixture');
  await expect(driver.finalizeEvidence('fixture')).rejects.toThrow('No run evidence journal');
});

test('warnings are distinct from failures and can fail CI by choice', async () => {
  const opts = options();
  opts.driver = new FakeBrowserDriver({ 'http://app.test/': { console: [{ level: 'warning', text: 'Deprecated API' }] } });
  const { run } = await runQa(opts);
  expect(run.verdict).toBe('warnings');
  expect(exitCodeForRun(run)).toBe(0);
  expect(exitCodeForRun(run, true)).toBe(1);
});

test('a missing screenshot cannot establish a passing result', async () => {
  const opts = options();
  opts.provider = new ScriptedProvider(async ctx => {
    const report = await passing(ctx);
    await rm(join(ctx.runtime.screenshotDir!, 'landing.png'));
    return report;
  });
  const { run } = await runQa(opts);
  expect(run).toMatchObject({ status: 'failed', verdict: 'inconclusive' });
  expect(exitCodeForRun(run)).toBe(2);
});

test('a symlink to another run cannot supply screenshot evidence', async () => {
  const opts = options();
  opts.provider = new ScriptedProvider(async ctx => {
    const report = await passing(ctx);
    const file = join(ctx.runtime.screenshotDir!, 'landing.png');
    const other = join(tempDir(), 'foreign.png');
    await Bun.write(other, await Bun.file(file).arrayBuffer());
    await rm(file);
    await symlink(other, file);
    return report;
  });
  expect((await runQa(opts)).run.verdict).toBe('inconclusive');
});

test('provider failures cannot establish PASS even if their final text is valid', async () => {
  const opts = options();
  const provider: AgentProvider = { name: 'failed-provider', async run(task) {
    return { ...await opts.provider.run(task), exitCode: 1, error: 'Provider connection failed' };
  } };
  const { run } = await runQa({ ...opts, provider });
  expect(run).toMatchObject({ status: 'failed', verdict: 'inconclusive' });
  expect(run.validationErrors?.join()).toContain('Provider connection failed');
});

test('timeouts and already-aborted runs never pass or execute scripted work', async () => {
  const opts = options();
  const controller = new AbortController();
  controller.abort();
  let called = false;
  opts.provider = new ScriptedProvider(() => { called = true; return ''; });
  const { run } = await runQa({ ...opts, signal: controller.signal });
  expect(called).toBe(false);
  expect(run).toMatchObject({ status: 'cancelled', verdict: 'inconclusive' });
  const timed = await runQa({ ...options(), timeoutMs: 5, provider: new ScriptedProvider(() => new Promise(() => {})) });
  expect(timed.run).toMatchObject({ status: 'cancelled', verdict: 'inconclusive' });
});

test('--no-atlas does not update verification history and retention rejects zero or fractions', async () => {
  const opts = options(await projectWithAtlas());
  const { run } = await runQa({ ...opts, useAtlas: false });
  expect(run.atlasUsed).toBe(false);
  expect(await readSurfaceVerifications(opts.projectDir)).toEqual({});
  await expect(runQa({ ...opts, keepRuns: 0 })).rejects.toThrow('positive integer');
  await expect(runQa({ ...opts, keepRuns: 1.5 })).rejects.toThrow('positive integer');
});

test('oversized screenshots become inconclusive before hashing and completed journals are released', async () => {
  const { truncate } = await import('node:fs/promises');
  const opts = options();
  opts.provider = new ScriptedProvider(async ctx => {
    const report = await passing(ctx);
    await truncate(join(ctx.runtime.screenshotDir!, 'landing.png'), 33 * 1024 * 1024);
    return report;
  });
  const { run } = await runQa(opts);
  expect(run.verdict).toBe('inconclusive');
  expect(run.validationErrors?.join()).toContain('bounded regular PNG');
  await expect(opts.driver.readEvidence(run.browserSessionId)).rejects.toThrow('No run evidence journal');
});

test('per-run accounting survives JSON and Markdown, including unknown and reported zero', async () => {
  for (const usage of [undefined, { inputTokens: 30, outputTokens: 5, costUsd: 0 }]) {
    const opts = options();
    const delegate = opts.provider;
    const provider: AgentProvider = { name: 'usage-fixture', async run(task) {
      return { ...await delegate.run(task), usage };
    } };
    const outcome = await runQa({ ...opts, provider });
    const json = await Bun.file(join(outcome.runDir, 'report.json')).json();
    expect(json.usage).toEqual(usage);
    const report = await Bun.file(outcome.reportPath).text();
    expect(report).toContain(`**Reported input tokens:** ${usage?.inputTokens ?? 'unknown'}`);
    expect(report).toContain(`**Reported output tokens:** ${usage?.outputTokens ?? 'unknown'}`);
    expect(report).toContain(`**Reported cost:** ${usage ? '$0.0000' : 'unknown'}`);
  }
});

test('reported usage survives a journal failure after the provider finishes', async () => {
  const opts = options();
  opts.driver.finalizeEvidence = async () => { throw new Error('journal unavailable'); };
  const delegate = opts.provider;
  const usage = { inputTokens: 20, outputTokens: 4, costUsd: 0.02 };
  const provider: AgentProvider = { name: 'usage-fixture', async run(task) { return { ...await delegate.run(task), usage }; } };
  const outcome = await runQa({ ...opts, provider });
  expect(outcome.run).toMatchObject({ verdict: 'inconclusive', usage });
  for (const file of ['run.json', 'report.json']) expect((await Bun.file(join(outcome.runDir, file)).json()).usage).toEqual(usage);
  const report = await Bun.file(outcome.reportPath).text();
  expect(report).toContain('**Reported input tokens:** 20');
  expect(report).toContain('**Reported output tokens:** 4');
  expect(report).toContain('**Reported cost:** $0.0200');
});
