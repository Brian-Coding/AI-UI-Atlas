import { ensureSafeDirectory } from '../../scripts/safe-artifacts.mjs';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../core/atomic-file';
import { runKeyedSerial } from '../core/keyed-serial';
import { isSafeId } from '../core/paths';
import { safeRemoveTree } from '../core/safe-filesystem.mjs';
import type { QaRunRecord } from './types';

export const RUN_RECORD_FILE = 'run.json';
const RUN_TOP_LEVEL_NAMES = [
  'run.json', 'report.json', 'report.md', 'prompt.md', 'system-prompt.md',
  'agent-output.md', 'transcript.ndjson', 'stderr.log', 'screenshots',
];

export function isRunRecord(value: any, id: string): value is QaRunRecord {
  const string = (v: unknown) => typeof v === 'string';
  const date = (v: unknown) => string(v) && /^\d{4}-\d{2}-\d{2}T/.test(v as string) && Number.isFinite(Date.parse(v as string));
  const strings = (v: unknown) => Array.isArray(v) && v.every(string);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || value.id !== id || !isSafeId(id)
    || !isSafeId(value.browserSessionId) || !date(value.createdAt)
    || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(value.status)
    || !string(value.url) || !/^https?:\/\//.test(value.url)
    || !string(value.goal) || !string(value.provider)) return false;
  for (const key of ['startedAt', 'finishedAt']) if (value[key] !== undefined && !date(value[key])) return false;
  for (const key of ['summary', 'error', 'model', 'changeDescription', 'rerunOf']) if (value[key] !== undefined && !string(value[key])) return false;
  for (const key of ['validationErrors', 'atlasSurfaceIds']) if (value[key] !== undefined && !strings(value[key])) return false;
  if (value.verdict !== undefined && !['pass', 'warnings', 'fail', 'inconclusive'].includes(value.verdict)) return false;
  const records = (items: any, valid: (item: any) => boolean) => items === undefined || (Array.isArray(items) && items.every(item => item && typeof item === 'object' && valid(item)));
  return records(value.assertions, item => string(item.id) && string(item.name) && ['passed', 'failed', 'warning', 'not_run'].includes(item.status) && strings(item.evidenceIds))
    && records(value.evidence, item => string(item.id) && string(item.label) && ['screenshot', 'console', 'network', 'observation'].includes(item.kind) && (item.ref === undefined || string(item.ref)))
    && records(value.findings, item => string(item.id) && string(item.title) && string(item.details) && ['critical', 'major', 'minor', 'note'].includes(item.severity) && strings(item.evidenceIds));
}

function isActive(run: Pick<QaRunRecord, 'status'>): boolean {
  return run.status === 'queued' || run.status === 'running';
}

/**
 * Choose which runs to keep when history exceeds `limit`. In-flight runs are
 * never evicted; the newest terminal runs fill the remaining slots.
 * (Adapted from Agent Forge's QA run history compaction.)
 */
export function selectRunsToPrune<T extends Pick<QaRunRecord, 'id' | 'status' | 'createdAt'>>(runs: T[], limit: number): T[] {
  const ordered = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const active = ordered.filter(isActive);
  const terminal = ordered.filter(run => !isActive(run));
  const terminalLimit = Math.max(0, limit - active.length);
  const keep = new Set(terminal.slice(terminal.length - terminalLimit).map(run => run.id));
  if (terminalLimit === 0) keep.clear();
  return terminal.filter(run => !keep.has(run.id));
}

/**
 * Filesystem store for QA runs. Each run owns one directory:
 *
 *   <runsDir>/<runId>/run.json          durable status record
 *                     report.md         human-readable report
 *                     report.json       final structured result
 *                     prompt.md         the exact task sent to the agent
 *                     agent-output.md   the agent's raw final message
 *                     transcript.ndjson provider event stream
 *                     screenshots/*.png evidence
 */
export class RunStore {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(readonly runsDir: string) {}

  runDir(id: string): string {
    if (!isSafeId(id)) throw new Error(`Invalid run ID: ${id}`);
    return join(this.runsDir, id);
  }

  screenshotsDir(id: string): string {
    return join(this.runDir(id), 'screenshots');
  }

  async create(record: QaRunRecord): Promise<QaRunRecord> {
    const dir = this.runDir(record.id);
    if (existsSync(dir)) throw new Error(`Run ${record.id} already exists`);
    await ensureSafeDirectory(this.runsDir);
    await mkdir(dir);
    await ensureSafeDirectory(join(dir, 'screenshots'));
    await atomicWriteFile(join(dir, RUN_RECORD_FILE), JSON.stringify(record, null, 2));
    return record;
  }

  async get(id: string): Promise<QaRunRecord | null> {
    try {
      const dir = this.runDir(id);
      const path = join(dir, RUN_RECORD_FILE);
      const [folder, file] = await Promise.all([lstat(dir), lstat(path)]);
      if (folder.isSymbolicLink() || file.isSymbolicLink() || !file.isFile() || file.size > 8 * 1024 * 1024) return null;
      const record = JSON.parse(await readFile(path, 'utf8'));
      if (!isRunRecord(record, id)) {
        console.warn(`Skipping invalid run record: ${id}/${RUN_RECORD_FILE}`);
        return null;
      }
      return record;
    } catch {
      return null;
    }
  }

  async update(id: string, patch: Partial<QaRunRecord>): Promise<QaRunRecord> {
    return runKeyedSerial(this.tails, id, async () => {
      const current = await this.get(id);
      if (!current) throw new Error(`Run ${id} not found`);
      const next = { ...current, ...patch, id: current.id, schemaVersion: 1 as const };
      for (const key of Object.keys(next) as Array<keyof QaRunRecord>) {
        if (next[key] === undefined) delete next[key];
      }
      await atomicWriteFile(join(this.runDir(id), RUN_RECORD_FILE), JSON.stringify(next, null, 2));
      return next;
    });
  }

  async writeFile(id: string, name: string, content: string): Promise<string> {
    if (!RUN_TOP_LEVEL_NAMES.includes(name)) throw new Error(`Unexpected run file: ${name}`);
    const path = join(this.runDir(id), name);
    await atomicWriteFile(path, content);
    return path;
  }

  async readFile(id: string, name: string): Promise<string | null> {
    if (!RUN_TOP_LEVEL_NAMES.includes(name)) return null;
    try {
      return await readFile(join(this.runDir(id), name), 'utf8');
    } catch {
      return null;
    }
  }

  /** Newest first. Unreadable or foreign directories are skipped. */
  async list(): Promise<QaRunRecord[]> {
    if (!existsSync(this.runsDir)) return [];
    const entries = await readdir(this.runsDir, { withFileTypes: true });
    const runs = await Promise.all(entries
      .filter(entry => entry.isDirectory() && isSafeId(entry.name))
      .map(entry => this.get(entry.name)));
    return runs
      .filter((run): run is QaRunRecord => !!run)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Delete the oldest terminal runs beyond `limit`. Returns removed IDs. */
  async prune(limit: number): Promise<string[]> {
    const doomed = selectRunsToPrune(await this.list(), limit);
    const removed: string[] = [];
    for (const run of doomed) {
      try {
        await safeRemoveTree({
          targetPath: this.runDir(run.id),
          allowedRoot: this.runsDir,
          reason: 'Prune an old QA run beyond the retention limit',
          mode: 'delete',
          permanent: true,
          allowNonEmpty: true,
          allowedTopLevelNames: RUN_TOP_LEVEL_NAMES,
          maxEntries: 20_000,
          expectedTargetName: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/,
        });
        removed.push(run.id);
      } catch {
        // A run directory with unexpected content is left alone on purpose.
      }
    }
    return removed;
  }
}
