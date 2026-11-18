// A scripted (no-LLM) Atlas agent for the Acme Notes demo.
//
//   bun run atlas build examples/demo-app --url http://127.0.0.1:4400 \
//     --provider script:examples/demo-app/agents/scripted-atlas.ts
//
// A real agent discovers surfaces by reading code and exploring; this script
// already knows the demo app. It still takes real screenshots through the
// browser API and writes the same candidate bundle, so the harness validates
// and publishes it exactly like an LLM-built atlas.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScriptedAgentContext } from '../../../src/providers/types';

interface SurfacePlan {
  id: string;
  name: string;
  route: string;
  reach: string;
  description: string;
  entityIds: string[];
  codeRefs: string[];
  actions: string[];
  states?: string[];
  /** Steps after navigating to the route, before the screenshot. */
  prepare?: (ctx: ScriptedAgentContext) => Promise<void>;
}

const ENTITIES = [
  { id: 'entity.note', name: 'Note', fields: ['id: string', 'title: string', 'body: string', 'tags: string[]', 'updatedAt: ISO string'], codeRefs: ['server.ts:9-17'], description: 'A plain-text note.' },
  { id: 'entity.tag', name: 'Tag', fields: ['label: string'], codeRefs: ['server.ts:9'], description: 'Free-form label grouping notes.' },
  { id: 'entity.user-settings', name: 'User settings', fields: ['displayName: string', 'theme: light | dark', 'weeklyDigest: boolean'], codeRefs: ['public/settings.html:9-17'], description: 'Per-user preferences.' },
];

const SURFACES: SurfacePlan[] = [
  {
    id: 'surface.notes-list', name: 'Notes list', route: '/', reach: 'App launch', description: 'Home page listing notes with search.',
    entityIds: ['entity.note', 'entity.tag'], codeRefs: ['public/index.html:6-13', 'public/index.html:25-33'],
    actions: ['Search notes', 'Open a note', 'Create a note'], states: ['Empty search result shows "No notes match your search."'],
  },
  {
    id: 'surface.new-note-dialog', name: 'New note dialog', route: '/', reach: 'Notes list -> click "New note"', description: 'Modal form for creating a note.',
    entityIds: ['entity.note'], codeRefs: ['public/index.html:14-22', 'public/index.html:34-45'], actions: ['Enter title and body', 'Create', 'Cancel'],
    states: ['Missing title shows "A title is required."'],
    prepare: async ctx => { await ctx.browser!.click('#new-note'); },
  },
  {
    id: 'surface.note-detail', name: 'Note detail', route: '/note?id=n1', reach: 'Notes list -> click a note title', description: 'One note with tags and timestamp.',
    entityIds: ['entity.note', 'entity.tag'], codeRefs: ['public/note.html:7-22'], actions: ['Back to all notes'], states: ['Unknown id shows "Note not found"'],
  },
  {
    id: 'surface.settings', name: 'Settings', route: '/settings', reach: 'Header -> "Settings"', description: 'Preferences form. Saving currently fails (see inconsistencies).',
    entityIds: ['entity.user-settings'], codeRefs: ['public/settings.html:8-31', 'server.ts:50-54'], actions: ['Edit display name', 'Choose theme', 'Toggle weekly digest', 'Save settings'],
  },
  {
    id: 'surface.about', name: 'About', route: '/about', reach: 'Header -> "About"', description: 'Static product information.',
    entityIds: [], codeRefs: ['public/about.html:1-12'], actions: [],
  },
];

const FLOWS = [
  { id: 'flow.open-new-note', name: 'Open new note dialog', fromSurfaceId: 'surface.notes-list', toSurfaceId: 'surface.new-note-dialog', trigger: 'Click "New note"' },
  { id: 'flow.open-note', name: 'Open a note', fromSurfaceId: 'surface.notes-list', toSurfaceId: 'surface.note-detail', trigger: 'Click a note title' },
  { id: 'flow.back-to-notes', name: 'Back to notes', fromSurfaceId: 'surface.note-detail', toSurfaceId: 'surface.notes-list', trigger: 'Click "All notes"' },
  { id: 'flow.go-settings', name: 'Go to settings', fromSurfaceId: 'surface.notes-list', toSurfaceId: 'surface.settings', trigger: 'Header "Settings" link' },
  { id: 'flow.go-about', name: 'Go to about', fromSurfaceId: 'surface.notes-list', toSurfaceId: 'surface.about', trigger: 'Header "About" link' },
];

export default async function scriptedAtlas(ctx: ScriptedAgentContext): Promise<string> {
  const { browser } = ctx;
  const { outputDir, runId, targetUrl } = ctx.runtime;
  if (!browser || !outputDir || !runId || !targetUrl) throw new Error('scripted-atlas needs a browser session, output directory, run ID, and target URL');
  const origin = new URL(targetUrl).origin;
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const completed: string[] = [];
  const checkpoint = async (phase: string, status = 'running') => writeFile(join(outputDir, 'checkpoint.json'), JSON.stringify({
    schemaVersion: 1, runId, status, phase, completedSurfaceIds: completed, lastActivityAt: new Date().toISOString(),
  }, null, 2));

  await checkpoint('browser walkthrough');
  await mkdir(join(outputDir, 'shots'), { recursive: true });
  for (const surface of SURFACES) {
    ctx.log(`Documenting ${surface.id}`);
    await browser.navigate(`${origin}${surface.route}`);
    await browser.waitForReady();
    await surface.prepare?.(ctx);
    await browser.screenshot({ name: surface.id.replace('.', '-') });
    completed.push(surface.id);
    await checkpoint(`documented ${surface.id}`);
  }

  const surfaces = SURFACES.map(({ prepare: _prepare, ...surface }) => ({
    ...surface,
    status: 'verified',
    screenshotRefs: [`shots/${surface.id.replace('.', '-')}.png`],
  }));
  await writeFile(join(outputDir, 'atlas.json'), JSON.stringify({
    schemaVersion: 1, runId, generatedAt: now, project: 'Acme Notes', entities: ENTITIES, surfaces, flows: FLOWS,
  }, null, 2));

  const md: string[] = [
    '---', 'schema_version: 1', 'project: Acme Notes', `last_full_scan: ${now}`,
    `total_surfaces: ${surfaces.length}`, `total_entities: ${ENTITIES.length}`, '---', '',
    '# UI Atlas: Acme Notes', '', '## 1. Data entities', '',
  ];
  for (const entity of ENTITIES) {
    md.push(`### ${entity.name}`, `ID: \`${entity.id}\``, `- Fields: ${entity.fields.map(f => `\`${f}\``).join(', ')}`,
      `- Defined in: ${entity.codeRefs.map(r => `\`${r}\``).join(', ')}`,
      `- Appears in: ${surfaces.filter(s => s.entityIds.includes(entity.id)).map(s => `\`${s.id}\``).join(', ') || 'none'}`, '');
  }
  md.push('## 2. Visual surfaces', '');
  for (const surface of surfaces) {
    md.push(`### ${surface.name}`, `- ID: \`${surface.id}\``, `- Route: \`${surface.route}\``, `- Code: ${surface.codeRefs.map(r => `\`${r}\``).join(', ')}`,
      `- How to reach: ${surface.reach}`, `- Data shown: ${surface.entityIds.map(id => `\`${id}\``).join(', ') || 'static text'}`,
      `- Actions: ${surface.actions.join('; ') || 'none'}`, `- Screenshot: \`${surface.screenshotRefs[0]}\``, `- Last verified: ${today}`, '');
  }
  md.push('## 3. Flows', '', ...FLOWS.map(f => `- \`${f.id}\`: \`${f.fromSurfaceId}\` -> \`${f.toSurfaceId}\` via ${f.trigger}`), '',
    '## 4. Coverage summary', '', `All ${surfaces.length} surfaces verified on ${today}.`, '',
    '## 5. Observed inconsistencies', '',
    '- **Saving settings fails.** `POST /api/settings` returns HTTP 500 (`server.ts:50-54`) and the page assumes success (`public/settings.html:22-29`), so the status stays on "Saving..." and a TypeError is logged.', '',
    '## 6. Open questions', '', '- None for this scripted scan.', '',
    '## 7. Changes since last scan', '', '- Initial scan.', '');
  await writeFile(join(outputDir, 'atlas.md'), md.join('\n'));
  await writeFile(join(outputDir, 'README.md'), [
    '# Acme Notes UI Atlas', '', `Schema version 1. Last scan: ${now}.`, '',
    'Start with `atlas.json` (machine-readable graph) or `atlas.md` (narrative). Screenshots live in `shots/`.', '',
    '## Limitations of this scan', '', 'Produced by the scripted demo agent; it documents a fixed set of known surfaces.', '',
  ].join('\n'));
  await writeFile(join(outputDir, 'changelog.md'), `# Changelog\n\n- ${today}: Initial scan. ${surfaces.length} surfaces (${surfaces.length}/${surfaces.length} verified), ${ENTITIES.length} entities.\n`);
  await writeFile(join(outputDir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, atlasSchemaVersion: 1, runId, status: 'complete', generatedAt: now }, null, 2));
  await checkpoint('complete', 'complete');
  return `Atlas candidate for run ${runId} is complete: ${surfaces.length} surfaces, ${ENTITIES.length} entities, ${FLOWS.length} flows.`;
}
