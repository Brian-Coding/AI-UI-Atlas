import { withProjectLock } from '../core/project-lock';
// Transactional UI Atlas runs. Adapted from Agent Forge's atlas.service:
// the agent writes a candidate bundle, the harness validates it, and only a
// valid candidate is atomically promoted to docs/ui-atlas. Workspace and
// hidden-agent bookkeeping is replaced by a small state file in .atlas-qa/.

import { existsSync, statSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWriteFile } from '../core/atomic-file';
import { ensureStateDir, projectPaths } from '../core/paths';
import { generateId } from '../core/process';
import { openHarness, type HarnessOptions } from '../harness';
import type { AgentProgressEvent, AgentProvider } from '../providers/types';
import {
  atlasCandidatePaths,
  createAtlasCandidate,
  discardAtlasCandidate,
  promoteAtlasCandidate,
  validateAtlasCandidate,
} from './atlas-artifacts';
import { buildAtlasKickoffPrompt, buildAtlasResumePrompt, buildAtlasSystemPrompt } from './atlas-prompt';
import { retainPublishedVerifications } from './verifications';

export const DEFAULT_ATLAS_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const CHECKPOINT_POLL_MS = 2500;

export type AtlasRunStatus = 'running' | 'validating' | 'paused' | 'failed' | 'completed';

export interface AtlasRunState {
  schemaVersion: 1;
  id: string;
  mode: 'build' | 'update';
  status: AtlasRunStatus;
  url: string;
  provider: string;
  model?: string;
  focus?: string;
  candidateRelPath: string;
  browserSessionId: string;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  lastActivityAt: string;
  phase: string;
  resumeCount: number;
  /** PID of the atlas-qa process driving the run (stale-run detection). */
  pid?: number;
  validationErrors?: string[];
  error?: string;
  surfaceCount?: number;
  entityCount?: number;
  verifiedSurfaceCount?: number;
}

export interface AtlasRunOptions extends HarnessOptions {
  projectDir: string;
  provider: AgentProvider;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
  onPhase?: (phase: string, state: AtlasRunState) => void;
}

export interface AtlasBuildOptions extends AtlasRunOptions {
  url: string;
  focus?: string;
  runId?: string;
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

export async function readAtlasRunState(projectDir: string): Promise<AtlasRunState | null> {
  try {
    const state = JSON.parse(await readFile(projectPaths(projectDir).atlasRunFile, 'utf8')) as AtlasRunState;
    // A run whose driving process died (crash, closed terminal) is resumable.
    if ((state.status === 'running' || state.status === 'validating') && state.pid !== process.pid && !processAlive(state.pid)) {
      return { ...state, status: 'paused', phase: 'interrupted (the driving process exited)' };
    }
    return state;
  } catch {
    return null;
  }
}

async function writeState(projectDir: string, state: AtlasRunState): Promise<AtlasRunState> {
  await ensureStateDir(projectDir);
  await atomicWriteFile(projectPaths(projectDir).atlasRunFile, JSON.stringify(state, null, 2));
  return state;
}

function assertProjectDir(projectDir: string): string {
  const root = resolve(projectDir);
  if (!existsSync(root)) throw new Error(`Project directory does not exist: ${root}`);
  if (!statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
  return realpathSync(root);
}

function validateUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`--url must be an absolute http(s) URL, got: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('--url must use http or https');
  return parsed.toString();
}

/** Start a new Atlas run (initial build, or an update when an atlas exists). */
export function buildAtlas(options: AtlasBuildOptions): Promise<AtlasRunState> {
  return withProjectLock(options.projectDir, () => buildAtlasLocked(options));
}

async function buildAtlasLocked(options: AtlasBuildOptions): Promise<AtlasRunState> {
  const projectDir = assertProjectDir(options.projectDir);
  const url = validateUrl(options.url);
  const existing = await readAtlasRunState(projectDir);
  if (existing && (existing.status === 'running' || existing.status === 'validating')) {
    throw new Error(`Atlas run ${existing.id} is already active for this project (pid ${existing.pid ?? '?'}).`);
  }
  if (existing && (existing.status === 'paused' || existing.status === 'failed')
    && existsSync(atlasCandidatePaths(projectDir, existing.id).candidateRoot)) {
    throw new Error(`Atlas run ${existing.id} is ${existing.status} with a resumable candidate. Run "atlas resume" or "atlas discard" first.`);
  }

  const runId = options.runId ?? generateId();
  const mode = existsSync(join(projectPaths(projectDir).atlasRoot, 'atlas.json')) ? 'update' : 'build';
  const candidate = await createAtlasCandidate(projectDir, runId);
  const now = new Date().toISOString();
  const state = await writeState(projectDir, {
    schemaVersion: 1,
    id: runId,
    mode,
    status: 'running',
    url,
    provider: options.provider.name,
    model: options.model,
    focus: options.focus?.trim() || undefined,
    candidateRelPath: candidate.candidateRelPath,
    browserSessionId: `atlas-${runId}`,
    createdAt: now,
    startedAt: now,
    lastActivityAt: now,
    phase: mode === 'build' ? 'initial discovery' : 'updating from the published atlas',
    resumeCount: 0,
    pid: process.pid,
  });
  const prompt = buildAtlasKickoffPrompt({
    runId,
    outputDir: candidate.candidateRoot,
    mode,
    browserSessionId: state.browserSessionId,
    focus: state.focus,
  });
  return executeAtlasTurn(projectDir, state, prompt, options);
}

/** Continue a paused or failed run from its checkpoint. */
export function resumeAtlas(options: AtlasRunOptions & { url?: string }): Promise<AtlasRunState> {
  return withProjectLock(options.projectDir, () => resumeAtlasLocked(options));
}

async function resumeAtlasLocked(options: AtlasRunOptions & { url?: string }): Promise<AtlasRunState> {
  const projectDir = assertProjectDir(options.projectDir);
  const state = await readAtlasRunState(projectDir);
  if (!state) throw new Error('No Atlas run to resume for this project.');
  if (state.status !== 'paused' && state.status !== 'failed') {
    throw new Error(`Atlas run ${state.id} is ${state.status}, not resumable.`);
  }
  const candidate = atlasCandidatePaths(projectDir, state.id);
  if (!existsSync(candidate.candidateRoot)) throw new Error('The Atlas candidate directory no longer exists. Start a new build.');
  const resumed = await writeState(projectDir, {
    ...state,
    url: options.url ? validateUrl(options.url) : state.url,
    status: 'running',
    provider: options.provider.name,
    model: options.model ?? state.model,
    phase: 'resuming from checkpoint',
    finishedAt: undefined,
    lastActivityAt: new Date().toISOString(),
    validationErrors: [],
    error: undefined,
    resumeCount: state.resumeCount + 1,
    pid: process.pid,
  });
  const prompt = buildAtlasResumePrompt({
    runId: state.id,
    outputDir: candidate.candidateRoot,
    validationErrors: state.validationErrors ?? [],
  });
  return executeAtlasTurn(projectDir, resumed, prompt, options);
}

/** Throw away a paused/failed candidate. The published atlas is untouched. */
export function discardAtlasRun(projectDir: string): Promise<AtlasRunState> {
  return withProjectLock(projectDir, () => discardAtlasRunLocked(projectDir));
}

async function discardAtlasRunLocked(projectDir: string): Promise<AtlasRunState> {
  const root = assertProjectDir(projectDir);
  const state = await readAtlasRunState(root);
  if (!state) throw new Error('No Atlas run to discard.');
  if (state.status === 'running' || state.status === 'validating') {
    throw new Error('Stop the running Atlas build before discarding its candidate.');
  }
  await discardAtlasCandidate(root, state.id);
  const { rm } = await import('node:fs/promises');
  await rm(projectPaths(root).atlasRunFile, { force: true });
  return state;
}

async function refreshCheckpoint(projectDir: string, state: AtlasRunState, onPhase?: AtlasRunOptions['onPhase']): Promise<AtlasRunState> {
  const checkpointPath = join(atlasCandidatePaths(projectDir, state.id).candidateRoot, 'checkpoint.json');
  try {
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as { runId?: string; phase?: string; lastActivityAt?: string };
    if (checkpoint.runId !== state.id) return state;
    const phase = typeof checkpoint.phase === 'string' && checkpoint.phase.trim() ? checkpoint.phase.trim().slice(0, 160) : state.phase;
    const parsedActivity = checkpoint.lastActivityAt ? Date.parse(checkpoint.lastActivityAt) : NaN;
    const lastActivityAt = Number.isFinite(parsedActivity)
      ? new Date(Math.max(Date.parse(state.lastActivityAt), Math.min(Date.now(), parsedActivity))).toISOString()
      : state.lastActivityAt;
    if (phase === state.phase && lastActivityAt === state.lastActivityAt) return state;
    const next = await writeState(projectDir, { ...state, phase, lastActivityAt });
    if (phase !== state.phase) onPhase?.(phase, next);
    return next;
  } catch {
    // The agent may be mid-write; the next poll retries.
    return state;
  }
}

async function executeAtlasTurn(
  projectDir: string,
  initial: AtlasRunState,
  prompt: string,
  options: AtlasRunOptions,
): Promise<AtlasRunState> {
  const candidate = atlasCandidatePaths(projectDir, initial.id);
  const harness = openHarness(options);
  harness.server.sessions.register({
    sessionId: initial.browserSessionId,
    kind: 'atlas',
    screenshotDir: join(candidate.candidateRoot, 'shots'),
    runId: initial.id,
  });
  let state = initial;
  let polling: Promise<void> = Promise.resolve();
  const poll = () => {
    polling = polling.then(async () => { state = await refreshCheckpoint(projectDir, state, options.onPhase); });
  };
  const timer = setInterval(poll, CHECKPOINT_POLL_MS);
  timer.unref?.();
  options.onPhase?.(state.phase, state);

  let interrupted = false;
  let executionError: string | undefined;
  try {
    const systemPrompt = buildAtlasSystemPrompt({
      apiBase: harness.server.url,
      token: harness.server.token,
      targetUrl: state.url,
      runId: state.id,
      outputDir: candidate.candidateRoot,
      browserSessionId: state.browserSessionId,
      projectDir,
    });
    const result = await options.provider.run({
      systemPrompt,
      prompt,
      cwd: projectDir,
      model: state.model,
      reasoningEffort: options.reasoningEffort,
      timeoutMs: options.timeoutMs ?? DEFAULT_ATLAS_TIMEOUT_MS,
      signal: options.signal,
      transcriptPath: join(projectPaths(projectDir).stateDir, 'atlas-transcripts', `${state.id}.ndjson`),
      onProgress: options.onProgress,
      runtime: {
        kind: 'atlas',
        apiBase: harness.server.url,
        token: harness.server.token,
        runId: state.id,
        browserSessionId: state.browserSessionId,
        targetUrl: state.url,
        projectDir,
        outputDir: candidate.candidateRoot,
        screenshotDir: join(candidate.candidateRoot, 'shots'),
      },
    });
    interrupted = result.timedOut || result.aborted;
    if (result.error) executionError = result.error.slice(0, 2000);
    else if (result.exitCode !== 0 && !interrupted) executionError = `Provider exited with code ${result.exitCode}`;
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
  } finally {
    clearInterval(timer);
    poll();
    await polling;
    harness.server.sessions.unregister(state.browserSessionId);
    await harness.driver.closeSession(state.browserSessionId).catch(() => {});
    await harness.close();
  }
  return finalizeAtlasRun(projectDir, state, { interrupted, executionError, onPhase: options.onPhase });
}

async function finalizeAtlasRun(
  projectDir: string,
  current: AtlasRunState,
  outcome: { interrupted: boolean; executionError?: string; onPhase?: AtlasRunOptions['onPhase'] },
): Promise<AtlasRunState> {
  let state = await writeState(projectDir, {
    ...current,
    status: 'validating',
    phase: 'validating candidate',
    lastActivityAt: new Date().toISOString(),
  });
  outcome.onPhase?.(state.phase, state);
  const validation = await validateAtlasCandidate(projectDir, state.id);
  if (!validation.valid || outcome.interrupted || outcome.executionError) {
    const paused = outcome.interrupted;
    return writeState(projectDir, {
      ...state,
      status: paused ? 'paused' : 'failed',
      phase: paused ? 'paused at checkpoint' : 'candidate needs attention',
      finishedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      validationErrors: validation.errors,
      error: outcome.executionError || (paused
        ? 'The run stopped before the candidate was complete. The published atlas is unchanged.'
        : 'Candidate validation failed. Review the errors, then run "atlas resume" to let the agent fix them.'),
      surfaceCount: validation.surfaceCount,
      entityCount: validation.entityCount,
      verifiedSurfaceCount: validation.verifiedSurfaceCount,
      pid: undefined,
    });
  }
  try {
    const promoted = await promoteAtlasCandidate(projectDir, state.id);
    state = await writeState(projectDir, {
      ...state,
      status: 'completed',
      phase: 'published',
      finishedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      validationErrors: [],
      error: undefined,
      surfaceCount: promoted.surfaceCount,
      entityCount: promoted.entityCount,
      verifiedSurfaceCount: promoted.verifiedSurfaceCount,
      pid: undefined,
    });
  } catch (error) {
    return writeState(projectDir, {
      ...state,
      status: 'failed',
      phase: 'publication failed',
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      pid: undefined,
    });
  }
  // Publication succeeded; cleanup problems must not turn it into a failure.
  await retainPublishedVerifications(projectDir).catch(() => {});
  await discardAtlasCandidate(projectDir, state.id).catch(() => {});
  outcome.onPhase?.(state.phase, state);
  return state;
}
