import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TINY_PNG } from '../src/browser/fake-driver';

const created: string[] = [];

export function tempDir(label = 'test'): string {
  const dir = mkdtempSync(join(tmpdir(), `atlas-qa-${label}-`));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
}

export const FIXTURE_GRAPH = {
  schemaVersion: 1,
  runId: 'fixture-run',
  generatedAt: '2026-01-01T00:00:00.000Z',
  project: 'Acme Notes',
  entities: [
    { id: 'entity.note', name: 'Note', fields: ['title: string', 'body: string'], codeRefs: ['src/note.ts:1-10'] },
    { id: 'entity.tag', name: 'Tag', fields: ['label: string'] },
    { id: 'entity.user-settings', name: 'User settings', fields: ['theme: light | dark'] },
  ],
  surfaces: [
    { id: 'surface.notes-list', name: 'Notes list', status: 'verified', route: '/', screenshotRefs: ['shots/surface-notes-list.png'], entityIds: ['entity.note', 'entity.tag'], actions: ['Search notes'] },
    { id: 'surface.note-detail', name: 'Note detail', status: 'verified', route: '/note', screenshotRefs: ['shots/surface-note-detail.png'], entityIds: ['entity.note', 'entity.tag'] },
    { id: 'surface.settings-modal', name: 'Settings modal', status: 'partial', reach: 'Header -> gear icon', screenshotRefs: [], entityIds: ['entity.user-settings'], actions: ['Change theme'] },
  ],
  flows: [
    { id: 'flow.open-note', name: 'Open note', fromSurfaceId: 'surface.notes-list', toSurfaceId: 'surface.note-detail', trigger: 'Click a note' },
    { id: 'flow.open-settings', name: 'Open settings', fromSurfaceId: 'surface.note-detail', toSurfaceId: 'surface.settings-modal', trigger: 'Click the gear icon' },
  ],
};

/** Write a complete, valid bundle into `dir` (a candidate or docs/ui-atlas). */
export async function writeAtlasBundle(dir: string, runId = 'fixture-run', graph: any = FIXTURE_GRAPH): Promise<void> {
  await mkdir(join(dir, 'shots'), { recursive: true });
  for (const surface of graph.surfaces) {
    for (const ref of surface.screenshotRefs ?? []) await writeFile(join(dir, ref), TINY_PNG);
  }
  await writeFile(join(dir, 'atlas.json'), JSON.stringify({ ...graph, runId }, null, 2));
  await writeFile(join(dir, 'atlas.md'), [
    '---', 'schema_version: 1', 'project: Acme Notes', 'last_full_scan: 2026-01-01T00:00:00.000Z',
    `total_surfaces: ${graph.surfaces.length}`, `total_entities: ${graph.entities.length}`, '---', '',
    '# UI Atlas: Acme Notes', '', '## 2. Visual surfaces', '',
    ...graph.surfaces.map((s: any) => `### ${s.name}\n- ID: \`${s.id}\`\n- Last verified: 2026-01-01`),
  ].join('\n'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, atlasSchemaVersion: 1, runId, status: 'complete', generatedAt: '2026-01-01T00:00:00.000Z' }));
  await writeFile(join(dir, 'checkpoint.json'), JSON.stringify({
    schemaVersion: 1, runId, status: 'complete', phase: 'complete',
    completedSurfaceIds: graph.surfaces.map((s: any) => s.id), lastActivityAt: '2026-01-01T00:00:00.000Z',
  }));
  await writeFile(join(dir, 'README.md'), '# Fixture atlas\n');
  await writeFile(join(dir, 'changelog.md'), '# Changelog\n\n- Initial scan.\n');
}

/** A project directory with a published atlas at docs/ui-atlas. */
export async function projectWithAtlas(): Promise<string> {
  const project = tempDir('project');
  await writeAtlasBundle(join(project, 'docs', 'ui-atlas'));
  return project;
}

export function collectIo(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text), cwd },
    out,
    err,
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}
