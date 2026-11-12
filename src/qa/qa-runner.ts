// One structured QA run, end to end. Adapted from Agent Forge's qa.service:
// the queue/workspace/chat plumbing is replaced by a single awaited function,
// while the evidence contract (result envelope validation, harness-side
// console/network corroboration, screenshot confinement) is unchanged.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureStateDir, isSafeId } from '../core/paths';
import { generateId } from '../core/process';
import { openHarness, type HarnessOptions } from '../harness';
import type { AgentProgressEvent, AgentProvider } from '../providers/types';
import { publishedSurfaceIds, recordSurfaceVerifications } from '../atlas/verifications';
import { corroborateBrowserEvidence, validateScreenshotEvidence } from './evidence';
import { buildQaSystemPrompt, buildQaTaskPrompt } from './qa-prompt';
import { formatQaReport, parseQaResult, type ParsedQaResult } from './qa-result';
import { renderRunReport } from './report';
import { RunStore } from './run-store';
import type { QaRunRecord } from './types';

export const DEFAULT_QA_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_KEEP_RUNS = 50;

export interface QaRunOptions extends HarnessOptions {
  /** Project whose `.atlas-qa/runs` stores the run (and whose atlas is used). */
  projectDir: string;
  url: string;
  goal: string;
  changeDescription?: string;
  provider: AgentProvider;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Consult docs/ui-atlas when present (default true). */
  useAtlas?: boolean;
  rerunOf?: string;
  keepRuns?: number;
  runId?: string;
  onProgress?: (event: AgentProgressEvent) => void;
  /** Called once the run record exists, before the agent starts. */
  onStart?: (run: QaRunRecord, runDir: string) => void;
}

export interface QaRunOutcome {
  run: QaRunRecord;
  runDir: string;
  reportPath: string;
}

function validateTarget(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`--url must be an absolute http(s) URL, got: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('--url must use http or https');
  return parsed.toString();
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join('<redacted-token>') : text;
}

export async function runQa(options: QaRunOptions): Promise<QaRunOutcome> {
  const url = validateTarget(options.url);
  const goal = options.goal.trim();
  if (!goal) throw new Error('A QA goal is required (what should be tested?)');
  if (goal.length > 20_000) throw new Error('The QA goal is too long (max 20000 characters)');
  const projectDir = resolve(options.projectDir);
  if (!existsSync(projectDir)) throw new Error(`Project directory does not exist: ${projectDir}`);

  const paths = await ensureStateDir(projectDir);
  const store = new RunStore(paths.runsDir);
  const runId = options.runId ?? generateId();
  if (!isSafeId(runId)) throw new Error(`Invalid run ID: ${runId}`);
  const browserSessionId = `qa-${runId}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_QA_TIMEOUT_MS;
  const atlasRoot = options.useAtlas === false ? undefined
    : existsSync(join(paths.atlasRoot, 'atlas.json')) ? paths.atlasRoot : undefined;

  const run = await store.create({
    schemaVersion: 1,
    id: runId,
    url,
    goal,
    changeDescription: options.changeDescription?.trim() || undefined,
    provider: options.provider.name,
    model: options.model,
    status: 'queued',
    browserSessionId,
    createdAt: new Date().toISOString(),
    rerunOf: options.rerunOf,
    atlasUsed: !!atlasRoot,
  });
  const runDir = store.runDir(runId);
  const screenshotsDir = store.screenshotsDir(runId);
  const reportPath = join(runDir, 'report.md');
  options.onStart?.(run, runDir);

  const harness = openHarness(options);
  harness.server.sessions.register({ sessionId: browserSessionId, kind: 'qa', screenshotDir: screenshotsDir, runId });

  try {
    const systemPrompt = buildQaSystemPrompt({
      apiBase: harness.server.url,
      token: harness.server.token,
      runId,
      browserSessionId,
      screenshotDir: screenshotsDir,
      atlasRoot,
      timeoutMinutes: Math.max(1, Math.round(timeoutMs / 60_000)),
    });
    const prompt = buildQaTaskPrompt({
      runId,
      browserSessionId,
      url,
      goal,
      changeDescription: run.changeDescription,
      projectDir,
    });
    await store.writeFile(runId, 'system-prompt.md', redact(systemPrompt, harness.server.token));
    await store.writeFile(runId, 'prompt.md', prompt);
    await store.update(runId, { status: 'running', startedAt: new Date().toISOString() });

    const result = await options.provider.run({
      systemPrompt,
      prompt,
      cwd: runDir,
      addDirs: [projectDir, ...(atlasRoot ? [atlasRoot] : [])],
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      timeoutMs,
      signal: options.signal,
      transcriptPath: join(runDir, 'transcript.ndjson'),
      onProgress: options.onProgress,
      runtime: {
        kind: 'qa',
        apiBase: harness.server.url,
        token: harness.server.token,
        runId,
        browserSessionId,
        targetUrl: url,
        projectDir,
        screenshotDir: screenshotsDir,
        atlasRoot,
      },
    });

    const rawReport = result.finalText.trim();
    await store.writeFile(runId, 'agent-output.md', redact(rawReport, harness.server.token) || '(no output)\n');
    const interrupted = result.timedOut || result.aborted;

    let parsed: ParsedQaResult;
    if (interrupted) {
      parsed = {
        authoritative: false,
        verdict: 'inconclusive',
        summary: result.timedOut
          ? `QA run reached its ${Math.round(timeoutMs / 60_000)}-minute execution limit.`
          : 'QA run was stopped before completion.',
        reportBody: rawReport || '(The run stopped before the QA agent produced output.)',
        validationErrors: ['Interrupted runs cannot produce an authoritative verdict'],
      };
    } else if (result.error && !rawReport) {
      parsed = {
        authoritative: false,
        verdict: 'inconclusive',
        summary: 'The QA agent failed before it could complete this run.',
        reportBody: '(No QA output was produced.)',
        validationErrors: [`Provider error: ${result.error.slice(0, 2000)}`],
      };
    } else {
      parsed = parseQaResult(rawReport, runId);
      parsed = await corroborateBrowserEvidence(parsed, harness.driver, browserSessionId);
      parsed = validateScreenshotEvidence(parsed, screenshotsDir, paths.runsDir);
    }

    const envelope = parsed.envelope;
    const status: QaRunRecord['status'] = interrupted ? 'cancelled' : parsed.authoritative ? 'completed' : 'failed';
    const finished = await store.update(runId, {
      status,
      finishedAt: new Date().toISOString(),
      verdict: parsed.verdict,
      summary: parsed.summary,
      assertions: envelope?.assertions ?? [],
      evidence: envelope?.evidence ?? [],
      findings: envelope?.findings ?? [],
      atlasSurfaceIds: envelope?.atlasSurfaceIds,
      validationErrors: parsed.validationErrors,
      error: parsed.authoritative ? undefined : parsed.summary,
      usage: result.usage && Object.keys(result.usage).length ? result.usage : undefined,
    });

    // Passed, evidence-backed assertions refresh the atlas verification history.
    if (parsed.authoritative && parsed.verdict === 'pass' && envelope) {
      const published = await publishedSurfaceIds(projectDir);
      if (published) {
        const exercised = envelope.assertions
          .filter(assertion => assertion.status === 'passed' && assertion.evidenceIds.length > 0)
          .flatMap(assertion => assertion.atlasSurfaceIds ?? [])
          .filter(id => published.has(id));
        await recordSurfaceVerifications(projectDir, exercised, runId).catch(() => {});
      }
    }

    const narrative = formatQaReport(parsed);
    await store.writeFile(runId, 'report.md', renderRunReport(finished, narrative, reportPath));
    await store.writeFile(runId, 'report.json', JSON.stringify({ ...finished, narrative }, null, 2));
    await store.prune(options.keepRuns ?? DEFAULT_KEEP_RUNS).catch(() => []);
    return { run: finished, runDir, reportPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await store.update(runId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      verdict: 'inconclusive',
      summary: 'The harness could not complete this QA run.',
      error: message.slice(0, 2000),
      validationErrors: [`Harness error: ${message.slice(0, 2000)}`],
    }).catch(() => run);
    await store.writeFile(runId, 'report.md', renderRunReport(failed, `INCONCLUSIVE — ${message}`, reportPath)).catch(() => {});
    await store.writeFile(runId, 'report.json', JSON.stringify(failed, null, 2)).catch(() => {});
    return { run: failed, runDir, reportPath };
  } finally {
    harness.server.sessions.unregister(browserSessionId);
    await harness.driver.closeSession(browserSessionId).catch(() => {});
    await harness.close();
  }
}

/** Process exit code for a finished run (used by the CLI and CI). */
export function exitCodeForRun(run: Pick<QaRunRecord, 'verdict'>, failOnWarnings = false): number {
  switch (run.verdict) {
    case 'pass': return 0;
    case 'warnings': return failOnWarnings ? 1 : 0;
    case 'fail': return 1;
    default: return 2;
  }
}
