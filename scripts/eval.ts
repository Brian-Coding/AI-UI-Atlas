// Sequential, isolated real-browser runs. Ground truth is used only by scoring;
// the provider receives the user goal and an otherwise empty project directory.
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir, platform, arch, release } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startDemoServer } from '../examples/demo-app/server';
import scriptedQa from '../examples/demo-app/agents/scripted-qa';
import { WorkerBrowserDriver } from '../src/browser/worker-driver';
import { resolveProvider } from '../src/providers/registry';
import { ScriptedProvider } from '../src/providers/scripted';
import { runQa } from '../src/qa/qa-runner';
import { cases, summarize } from './evals/cases';

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  provider: { type: 'string', default: 'scripted' }, model: { type: 'string' },
  repeats: { type: 'string', default: '1' }, output: { type: 'string' },
  'timeout-ms': { type: 'string', default: '120000' },
}, strict: true });
const repeats = Number(values.repeats);
const timeoutMs = Number(values['timeout-ms']);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) throw new Error('--repeats must be 1–100');
if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('--timeout-ms must be positive');
if (!['scripted', 'claude', 'codex'].includes(values.provider!)) throw new Error('--provider must be scripted, claude, or codex');
const output = values.output ? resolve(values.output) : await mkdtemp(join(tmpdir(), 'atlas-eval-'));
await mkdir(output, { recursive: true });
const batchDir = await mkdtemp(join(output, 'runs-'));
const provider = values.provider === 'scripted' ? new ScriptedProvider(scriptedQa, 'scripted-eval') : await resolveProvider(values.provider);
const driver = new WorkerBrowserDriver();
const startedAt = new Date().toISOString();
const git = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim();
const rows = [];
const metadata = {
  schemaVersion: 1, startedAt, commit: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--porcelain']),
  provider: values.provider, model: values.model ?? null, repeats, timeoutMs,
  environment: { platform: platform(), arch: arch(), kernel: release(), bun: Bun.version,
    node: Bun.spawnSync(['node', '--version']).stdout.toString().trim() },
  scope: 'QA only; no Atlas supplied. Scripted results measure harness/oracle behavior, not model quality.',
};
try {
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const fixture of cases) {
      const projectDir = await mkdtemp(join(batchDir, 'project-'));
      const app = startDemoServer(0, fixture.id);
      const start = performance.now();
      try {
        const outcome = await runQa({ projectDir, url: `http://127.0.0.1:${app.port}${fixture.path}`,
          goal: fixture.goal, provider, driver, model: values.model, timeoutMs, useAtlas: false });
        const row = { case: fixture.id, repeat, bug: fixture.bug, verdict: outcome.run.verdict ?? 'inconclusive',
          status: outcome.run.status, durationMs: Math.round(performance.now() - start),
          inputTokens: outcome.run.usage?.inputTokens ?? null, outputTokens: outcome.run.usage?.outputTokens ?? null,
          costUsd: outcome.run.usage?.costUsd ?? null, report: relative(output, outcome.reportPath),
          validationErrors: outcome.run.validationErrors ?? [] };
        rows.push(row);
        console.log(`${fixture.id} #${repeat}: ${row.verdict.toUpperCase()} (${row.durationMs}ms), tokens ${row.inputTokens ?? 'unknown'}/${row.outputTokens ?? 'unknown'}, cost ${row.costUsd ?? 'unknown'}`);
      } finally { app.stop(true); }
      // Checkpoint after every run; interrupted batches retain completed rows.
      await Bun.write(join(output, 'results.json'), JSON.stringify({ ...metadata, rows, summary: summarize(rows) }, null, 2) + '\n');
    }
  }
} finally { await driver.close(); }
console.log(JSON.stringify(summarize(rows), null, 2));
console.log(`Raw results and per-run evidence: ${join(output, 'results.json')}`);
// FAIL is expected for planted bugs. Warnings/inconclusive are never a clean control.
if (rows.some(row => row.verdict !== (row.bug ? 'fail' : 'pass'))) process.exitCode = 1;
