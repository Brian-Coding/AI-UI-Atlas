import { TINY_PNG } from '../browser/fake-driver';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  atlasCandidatePaths,
  createAtlasCandidate,
  discardAtlasCandidate,
  promoteAtlasCandidate,
  validateAtlasCandidate,
  validatePublishedAtlas,
} from './atlas-artifacts';

const tempProjects: string[] = [];

function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'atlas-qa-atlas-'));
  tempProjects.push(project);
  return project;
}

afterEach(() => {
  while (tempProjects.length) {
    const project = tempProjects.pop()!;
    rmSync(project, { recursive: true, force: true });
  }
});

async function writeValidCandidate(project: string, runId: string): Promise<void> {
  const paths = await createAtlasCandidate(project, runId);
  await writeFile(join(paths.candidateRoot, 'shots', 'surface-home.png'), TINY_PNG);
  await writeFile(join(paths.candidateRoot, 'atlas.md'), [
    '---',
    'schema_version: 1',
    'last_full_scan: 2026-07-14T12:00:00.000Z',
    'total_surfaces: 1',
    'total_entities: 1',
    '---',
    '',
    '# UI Atlas — Fixture',
    '',
    '## Visual surfaces',
    '### `surface.home` — Home',
    '- Screenshot: `shots/surface-home.png`',
    '- Last verified: 2026-07-14',
  ].join('\n'));
  await writeFile(join(paths.candidateRoot, 'atlas.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    generatedAt: '2026-07-14T12:00:00.000Z',
    project: 'Fixture',
    entities: [{ id: 'entity.user', name: 'User', fields: ['name'], codeRefs: ['src/user.ts'], description: 'App user' }],
    surfaces: [{
      id: 'surface.home',
      name: 'Home',
      status: 'verified',
      screenshotRefs: ['shots/surface-home.png'],
      entityIds: ['entity.user'],
      route: '/',
      reach: 'Open the app',
      description: 'Home page',
      actions: ['Refresh'],
      states: ['Ready'],
      codeRefs: ['src/home.ts'],
    }],
    flows: [{ id: 'flow.refresh', name: 'Refresh home', fromSurfaceId: 'surface.home', toSurfaceId: 'surface.home', trigger: 'Click Refresh' }],
  }, null, 2));
  await writeFile(join(paths.candidateRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    atlasSchemaVersion: 1,
    runId,
    status: 'complete',
    generatedAt: '2026-07-14T12:00:00.000Z',
  }, null, 2));
  await writeFile(join(paths.candidateRoot, 'checkpoint.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    status: 'complete',
    phase: 'complete',
    completedSurfaceIds: ['surface.home'],
    lastActivityAt: '2026-07-14T12:00:00.000Z',
  }, null, 2));
  await writeFile(join(paths.candidateRoot, 'README.md'), '# Atlas');
  await writeFile(join(paths.candidateRoot, 'changelog.md'), '# Changes');
}

describe('Atlas candidate publication', () => {
  test('rejects non-object metadata without replacing the published Atlas', async () => {
    const project = makeProject();
    await writeValidCandidate(project, 'published');
    await promoteAtlasCandidate(project, 'published');
    const canonical = join(project, 'docs', 'ui-atlas', 'manifest.json');
    const published = await readFile(canonical, 'utf8');
    const runId = 'invalid-metadata';
    await writeValidCandidate(project, runId);
    const paths = atlasCandidatePaths(project, runId);
    for (const name of ['manifest.json', 'checkpoint.json']) {
      const path = join(paths.candidateRoot, name);
      const original = await readFile(path, 'utf8');
      for (const value of [null, false, 0, '', []]) {
        await writeFile(path, JSON.stringify(value));
        const result = await validateAtlasCandidate(project, runId);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain(`${name} must be a JSON object`);
        await expect(promoteAtlasCandidate(project, runId)).rejects.toThrow('must be a JSON object');
        expect(await readFile(canonical, 'utf8')).toBe(published);
      }
      await writeFile(path, original);
    }
  });

  test('rejects a verified surface whose evidence is missing', async () => {
    const project = makeProject();
    const runId = 'missing-evidence';
    await writeValidCandidate(project, runId);
    const paths = atlasCandidatePaths(project, runId);
    rmSync(join(paths.candidateRoot, 'shots', 'surface-home.png'));

    const result = await validateAtlasCandidate(project, runId);
    expect(result.valid).toBe(false);
    expect(result.errors.some(error => error.includes('does not exist'))).toBe(true);
  });

  test('rejects an incomplete required bundle and fake PNG evidence', async () => {
    const project = makeProject();
    const runId = 'invalid-bundle';
    await writeValidCandidate(project, runId);
    const paths = atlasCandidatePaths(project, runId);
    rmSync(join(paths.candidateRoot, 'README.md'));
    await writeFile(join(paths.candidateRoot, 'shots', 'surface-home.png'), 'not-a-png');

    const result = await validateAtlasCandidate(project, runId);
    expect(result.valid).toBe(false);
    expect(result.errors.some(error => error.includes('README.md is missing'))).toBe(true);
    expect(result.errors.some(error => error.includes('valid PNG'))).toBe(true);
  });

  test('publishes a valid candidate and archives the previous Atlas', async () => {
    const project = makeProject();
    const canonical = join(project, 'docs', 'ui-atlas');
    await mkdir(join(canonical, 'shots'), { recursive: true });
    await writeFile(join(canonical, 'atlas.md'), '# Last good Atlas');
    await writeFile(join(canonical, 'shots', 'old.png'), 'old-png');

    const runId = 'publish-good';
    await writeValidCandidate(project, runId);
    const result = await promoteAtlasCandidate(project, runId);

    expect(result.valid).toBe(true);
    expect(await readFile(join(canonical, 'atlas.md'), 'utf8')).toContain('Fixture');
    expect(existsSync(join(canonical, 'atlas.json'))).toBe(true);
    const historyEntries = await readdir(join(canonical, '.history'));
    expect(historyEntries.length).toBe(1);
    expect(await readFile(join(canonical, '.history', historyEntries[0]!, 'atlas.md'), 'utf8')).toContain('Last good');
  });

  test('recovers a last-good Atlas left in rollback before publishing', async () => {
    const project = makeProject();
    const runId = 'recover-rollback';
    const canonical = join(project, 'docs', 'ui-atlas');
    const rollback = join(project, 'docs', '.ui-atlas-staging', `rollback-${runId}`);
    await mkdir(rollback, { recursive: true });
    await writeFile(join(rollback, 'atlas.md'), '# Last good after interrupted swap');
    await writeValidCandidate(project, runId);

    const result = await promoteAtlasCandidate(project, runId);

    expect(result.valid).toBe(true);
    expect(await readFile(join(canonical, 'atlas.md'), 'utf8')).toContain('Fixture');
    const historyEntries = await readdir(join(canonical, '.history'));
    expect(await readFile(join(canonical, '.history', historyEntries[0]!, 'atlas.md'), 'utf8'))
      .toContain('Last good after interrupted swap');
    expect(existsSync(rollback)).toBe(false);
  });

  test('treats a retry after successful publication as idempotent', async () => {
    const project = makeProject();
    const runId = 'idempotent-publish';
    await writeValidCandidate(project, runId);

    await promoteAtlasCandidate(project, runId);
    const retry = await promoteAtlasCandidate(project, runId);

    expect(retry.valid).toBe(true);
    expect(await readFile(join(project, 'docs', 'ui-atlas', 'atlas.md'), 'utf8')).toContain('Fixture');
  });

  test('validates the published bundle against its own manifest', async () => {
    const project = makeProject();
    expect((await validatePublishedAtlas(project)).errors[0]).toContain('No published UI Atlas');

    const runId = 'published-check';
    await writeValidCandidate(project, runId);
    await promoteAtlasCandidate(project, runId);
    const published = await validatePublishedAtlas(project);
    expect(published.valid).toBe(true);
    expect(published.surfaceCount).toBe(1);
  });

  test('rejects non-string optional surface fields', async () => {
    const project = makeProject();
    const runId = 'bad-route';
    await writeValidCandidate(project, runId);
    const graphPath = join(atlasCandidatePaths(project, runId).candidateRoot, 'atlas.json');
    const graph = JSON.parse(await readFile(graphPath, 'utf8'));
    graph.surfaces[0].route = 42;
    await writeFile(graphPath, JSON.stringify(graph));
    const result = await validateAtlasCandidate(project, runId);
    expect(result.errors).toContain('Surface surface.home route must be a string');
  });

  const invalidStrings = [42, null, {}, ['text']];
  const invalidArrays = ['text', null, {}, ['text', 42], ['text', null], ['text', {}]];
  const malformedFields: Array<[string, unknown[]]> = [
    ['project', invalidStrings],
    ['generatedAt', [2026, null, {}, ['2026-07-14']]],
    ...['route', 'reach', 'description'].map(key => [`surfaces.0.${key}`, invalidStrings] as [string, unknown[]]),
    ...['actions', 'states', 'codeRefs', 'entityIds', 'screenshotRefs'].map(key => [`surfaces.0.${key}`, invalidArrays] as [string, unknown[]]),
    ...['fields', 'codeRefs'].map(key => [`entities.0.${key}`, invalidArrays] as [string, unknown[]]),
    ['entities.0.description', invalidStrings],
    ['flows.0.trigger', invalidStrings],
    ['flows', ['text', null, {}, [null], ['text']]],
  ];

  test.each(malformedFields)('rejects malformed %s without replacing the publication', async (field, values) => {
    const project = makeProject();
    await writeValidCandidate(project, 'last-good');
    await promoteAtlasCandidate(project, 'last-good');
    const canonical = join(project, 'docs', 'ui-atlas');
    const names = ['atlas.json', 'manifest.json', 'checkpoint.json', 'atlas.md', 'README.md', 'changelog.md', 'shots/surface-home.png'];
    const previous = await Promise.all(names.map(name => readFile(join(canonical, name))));
    await writeValidCandidate(project, 'malformed');
    const graphPath = join(atlasCandidatePaths(project, 'malformed').candidateRoot, 'atlas.json');
    const original = await readFile(graphPath, 'utf8');

    for (const value of values) {
      const graph = JSON.parse(original);
      const keys = field.split('.');
      const target = keys.slice(0, -1).reduce((record, key) => record[key], graph);
      target[keys.at(-1)!] = value;
      // Unverified surfaces may omit evidence, but present references still need valid types.
      if (field === 'surfaces.0.screenshotRefs') graph.surfaces[0].status = 'unverified';
      await writeFile(graphPath, JSON.stringify(graph));
      expect((await validateAtlasCandidate(project, 'malformed')).valid).toBe(false);
      await expect(promoteAtlasCandidate(project, 'malformed')).rejects.toThrow('Atlas candidate failed validation');
      expect(await Promise.all(names.map(name => readFile(join(canonical, name))))).toEqual(previous);
      expect((await validatePublishedAtlas(project)).valid).toBe(true);
    }
  });

  test('published validation rejects malformed actions too', async () => {
    const project = makeProject();
    await writeValidCandidate(project, 'published-malformed');
    await promoteAtlasCandidate(project, 'published-malformed');
    const graphPath = join(project, 'docs', 'ui-atlas', 'atlas.json');
    const graph = JSON.parse(await readFile(graphPath, 'utf8'));
    graph.surfaces[0].actions = 'Search notes';
    await writeFile(graphPath, JSON.stringify(graph));
    const result = await validatePublishedAtlas(project);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Surface surface.home actions must be an array of strings');
  });

  test('rejects non-object graphs and accepts omitted or empty optional fields', async () => {
    const project = makeProject();
    await writeValidCandidate(project, 'graph-shape');
    const graphPath = join(atlasCandidatePaths(project, 'graph-shape').candidateRoot, 'atlas.json');
    const graph = JSON.parse(await readFile(graphPath, 'utf8'));
    for (const value of [null, false, 42, 'text', []]) {
      await writeFile(graphPath, JSON.stringify(value));
      const result = await validateAtlasCandidate(project, 'graph-shape');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('atlas.json must be an object');
    }
    delete graph.project;
    delete graph.flows;
    for (const key of ['route', 'reach', 'description', 'actions', 'states', 'codeRefs', 'entityIds', 'screenshotRefs']) delete graph.surfaces[0][key];
    graph.surfaces[0].status = 'unverified';
    delete graph.entities[0].description;
    graph.entities[0].fields = [];
    graph.entities[0].codeRefs = [];
    await writeFile(graphPath, JSON.stringify(graph));
    expect((await validateAtlasCandidate(project, 'graph-shape')).valid).toBe(true);
  });

  test('discarding a candidate removes it and its empty container', async () => {
    const project = makeProject();
    const runId = 'discard-me';
    await writeValidCandidate(project, runId);
    const paths = atlasCandidatePaths(project, runId);
    await discardAtlasCandidate(project, runId);
    expect(existsSync(paths.candidateRoot)).toBe(false);
    expect(await readFile(join(paths.candidatesRoot, '.gitignore'), 'utf8')).toContain('\n*\n');
  });
});
