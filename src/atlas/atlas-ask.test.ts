import { afterEach, expect, test } from 'bun:test';
import { cleanupTempDirs, projectWithAtlas } from '../../tests/helpers';
import { ScriptedProvider } from '../providers/scripted';
import { askAtlas } from './atlas-ask';
import { ATLAS_ANSWER_START, ATLAS_ANSWER_END } from './atlas-query-result';
import { loadPublishedAtlas, queryAtlas } from './atlas-search';

afterEach(cleanupTempDirs);
const answer = (id: string) => `${ATLAS_ANSWER_START}\n${JSON.stringify({ answer: `See ${id}.`, citations: [id] })}\n${ATLAS_ANSWER_END}`;

test('offline search maps an entity to its screens and navigation to a click path', async () => {
  const { graph } = await loadPublishedAtlas(await projectWithAtlas());
  const result = queryAtlas(graph, 'where are tags shown?');
  expect(result.intent).toBe('entity-surfaces');
  if (result.intent === 'entity-surfaces') expect(result.surfaces.map(s => s.id)).toEqual(['surface.notes-list', 'surface.note-detail']);
  const route = queryAtlas(graph, 'how do I get to surface.settings-modal?');
  expect(route.intent).toBe('surface');
  if (route.intent === 'surface') expect(route.detail.clickPath?.length).toBe(2);
});

test('Ask Atlas accepts grounded citations and rejects invented IDs', async () => {
  const projectDir = await projectWithAtlas();
  const opts = { projectDir, question: 'Where are notes shown?', provider: new ScriptedProvider(() => answer('surface.notes-list')) };
  expect((await askAtlas(opts)).citations).toEqual(['surface.notes-list']);
  await expect(askAtlas({ ...opts, provider: new ScriptedProvider(() => answer('surface.invented')) })).rejects.toThrow();
});

test('only one Ask per project runs at once and failures release the guard', async () => {
  const projectDir = await projectWithAtlas();
  let release!: (text: string) => void;
  const blocked = new ScriptedProvider(() => new Promise(resolve => { release = resolve; }));
  const first = askAtlas({ projectDir, question: 'Notes?', provider: blocked });
  await expect(askAtlas({ projectDir, question: 'Tags?', provider: blocked })).rejects.toThrow('already answering');
  while (!release) await Bun.sleep(1);
  release(answer('surface.notes-list'));
  await first;
  await expect(askAtlas({ projectDir, question: 'Notes?', provider: {
    name: 'broken', async run() { return { finalText: answer('surface.notes-list'), exitCode: 1, timedOut: false, aborted: false, error: 'Provider failed' }; },
  } })).rejects.toThrow('Provider failed');
  expect((await askAtlas({ projectDir, question: 'Notes?', provider: new ScriptedProvider(() => answer('surface.notes-list')) })).citations).toHaveLength(1);
});
