import { afterEach, expect, test } from 'bun:test';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDirs, projectWithAtlas } from '../../tests/helpers';
import { createViewerApi } from './viewer-api';

afterEach(cleanupTempDirs);

test('viewer lists and queries artifacts, blocks traversal/symlink escape, and disables paid Ask by default', async () => {
  const projectDir = await projectWithAtlas();
  const handle = createViewerApi({ projectDir });
  const get = async (path: string, method = 'GET', body?: object) => {
    const url = new URL(path, 'http://127.0.0.1:4477');
    return handle(new Request(url, { method, body: body ? JSON.stringify(body) : undefined }), url);
  };
  expect((await (await get('/api/project'))!.json()).atlas.published).toBe(true);
  expect((await get('/api/atlas/file?relPath=atlas.json'))?.status).toBe(200);
  expect((await (await get('/api/atlas/query?q=tags'))!.json()).intent).toBe('entity-surfaces');
  expect((await get('/api/atlas/file?relPath=../../private.json'))?.status).toBe(403);
  expect((await get('/api/atlas/file?relPath=app.html'))?.status).toBe(400);
  await Bun.write(join(projectDir, 'private.json'), '{"private":true}');
  await symlink(join(projectDir, 'private.json'), join(projectDir, 'docs/ui-atlas/escape.json'));
  expect((await get('/api/atlas/file?relPath=escape.json'))?.status).toBe(403);
  expect((await get('/api/atlas/ask', 'POST', { question: 'Notes?' }))?.status).toBe(501);
  expect(await (await get('/api/qa/runs'))!.json()).toEqual([]);
});
