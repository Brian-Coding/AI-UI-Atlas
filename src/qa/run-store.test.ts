import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDirs, tempDir } from '../../tests/helpers';
import { RunStore, selectRunsToPrune } from './run-store';
import type { QaRunRecord, QaRunStatus } from './types';

afterEach(cleanupTempDirs);

function record(id: string, status: QaRunStatus = 'completed', createdAt = `2026-01-01T00:00:0${id.slice(-1)}.000Z`): QaRunRecord {
  return { schemaVersion: 1, id, url: 'http://app.test/', goal: 'goal', provider: 'scripted', status, browserSessionId: `qa-${id}`, createdAt };
}

describe('RunStore', () => {
  test('creates, updates, reads, and lists runs newest first', async () => {
    const store = new RunStore(join(tempDir('runs'), 'runs'));
    await store.create(record('run-1'));
    await store.create(record('run-2'));
    expect(existsSync(store.screenshotsDir('run-1'))).toBe(true);
    await expect(store.create(record('run-1'))).rejects.toThrow('already exists');

    const updated = await store.update('run-1', { status: 'running', verdict: 'pass', summary: undefined });
    expect(updated.status).toBe('running');
    expect('summary' in updated).toBe(false);
    expect((await store.get('run-1'))?.verdict).toBe('pass');
    expect((await store.list()).map(run => run.id)).toEqual(['run-2', 'run-1']);
    await expect(store.update('missing', {})).rejects.toThrow('not found');
  });

  test('serializes concurrent updates to one run', async () => {
    const store = new RunStore(join(tempDir('runs'), 'runs'));
    await store.create(record('run-1'));
    await Promise.all([
      store.update('run-1', { summary: 'a' }),
      store.update('run-1', { verdict: 'fail' }),
      store.update('run-1', { error: 'boom' }),
    ]);
    expect(await store.get('run-1')).toMatchObject({ summary: 'a', verdict: 'fail', error: 'boom' });
  });

  test('rejects unsafe IDs and unexpected file names', async () => {
    const store = new RunStore(join(tempDir('runs'), 'runs'));
    expect(() => store.runDir('../escape')).toThrow('Invalid run ID');
    await store.create(record('run-1'));
    await expect(store.writeFile('run-1', '../../x.md', 'x')).rejects.toThrow('Unexpected run file');
    expect(await store.readFile('run-1', 'secrets.txt')).toBeNull();
    await store.writeFile('run-1', 'report.md', '# ok');
    expect(await store.readFile('run-1', 'report.md')).toBe('# ok');
  });

  test('list skips foreign and unreadable directories', async () => {
    const runsDir = join(tempDir('runs'), 'runs');
    const store = new RunStore(runsDir);
    await store.create(record('run-1'));
    await mkdir(join(runsDir, 'not-a-run'), { recursive: true });
    await mkdir(join(runsDir, 'broken'), { recursive: true });
    await writeFile(join(runsDir, 'broken', 'run.json'), '{oops');
    expect((await store.list()).map(run => run.id)).toEqual(['run-1']);
  });

  test('prunes the oldest terminal runs but never active ones', async () => {
    const store = new RunStore(join(tempDir('runs'), 'runs'));
    await store.create(record('run-1'));
    await store.create(record('run-2', 'running'));
    await store.create(record('run-3', 'failed'));
    await store.create(record('run-4'));
    const removed = await store.prune(2);
    expect(removed).toEqual(['run-1', 'run-3']);
    expect((await store.list()).map(run => run.id).sort()).toEqual(['run-2', 'run-4']);
  });
});

describe('selectRunsToPrune', () => {
  test('keeps active runs and the newest terminal runs within the limit', () => {
    const runs = [record('r-1'), record('r-2', 'queued'), record('r-3'), record('r-4', 'running'), record('r-5')];
    expect(selectRunsToPrune(runs, 3).map(run => run.id)).toEqual(['r-1', 'r-3']);
    expect(selectRunsToPrune(runs, 1).map(run => run.id)).toEqual(['r-1', 'r-3', 'r-5']);
    expect(selectRunsToPrune(runs, 10)).toEqual([]);
  });
});

test('schema-invalid JSON and directory-ID mismatch are isolated from listing and pruning', async () => {
  const runsDir = join(tempDir('invalid-records'), 'runs');
  const store = new RunStore(runsDir);
  await store.create(record('run-1'));
  for (const [id, value] of Object.entries({ empty: {}, alsoempty: {}, wrongid: record('run-1'), badtime: { ...record('badtime'), createdAt: 5 }, badstatus: { ...record('badstatus'), status: 'bogus' } })) {
    await mkdir(join(runsDir, id));
    await writeFile(join(runsDir, id, 'run.json'), JSON.stringify(value));
  }
  expect((await store.list()).map(r => r.id)).toEqual(['run-1']);
  expect(await store.prune(1)).toEqual([]);
  expect(existsSync(join(runsDir, 'wrongid'))).toBe(true);
});
