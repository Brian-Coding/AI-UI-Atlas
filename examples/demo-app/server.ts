// Acme Notes: a tiny multi-page demo app for trying UI Atlas and QA runs.
// It has one deliberate bug: saving settings fails (HTTP 500 + console error).
//
//   bun examples/demo-app/server.ts            # http://localhost:4400
//   PORT=5000 bun examples/demo-app/server.ts

import { join } from 'node:path';

interface Note { id: string; title: string; body: string; tags: string[]; updatedAt: string }

export function createNotes(): Note[] {
  return [
    { id: 'n1', title: 'Welcome to Acme Notes', body: 'Notes are plain text. Tags group related notes.', tags: ['getting-started'], updatedAt: '2026-01-05T09:00:00.000Z' },
    { id: 'n2', title: 'Grocery list', body: 'Oats, apples, coffee beans.', tags: ['personal'], updatedAt: '2026-01-06T17:30:00.000Z' },
    { id: 'n3', title: 'Project kickoff agenda', body: 'Goals, owners, timeline, risks.', tags: ['work', 'meetings'], updatedAt: '2026-01-07T08:15:00.000Z' },
  ];
}

const PUBLIC_DIR = join(import.meta.dir, 'public');
const PAGES: Record<string, string> = {
  '/': 'index.html',
  '/note': 'note.html',
  '/settings': 'settings.html',
  '/about': 'about.html',
};

export function startDemoServer(port = Number(process.env.PORT ?? 4400)) {
  const notes = createNotes();
  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/notes' && req.method === 'GET') return Response.json(notes);
      if (url.pathname === '/api/notes' && req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as Partial<Note>;
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) return Response.json({ error: 'title is required' }, { status: 400 });
        const note: Note = { id: `n${notes.length + 1}`, title, body: String(body.body ?? ''), tags: [], updatedAt: new Date().toISOString() };
        notes.unshift(note);
        return Response.json(note, { status: 201 });
      }
      const noteMatch = url.pathname.match(/^\/api\/notes\/([a-z0-9]+)$/);
      if (noteMatch && req.method === 'GET') {
        const note = notes.find(item => item.id === noteMatch[1]);
        return note ? Response.json(note) : Response.json({ error: 'not found' }, { status: 404 });
      }
      if (url.pathname === '/api/settings' && req.method === 'POST') {
        // Deliberate bug for the QA demo: the handler crashes on every save.
        return Response.json({ error: 'TypeError: Cannot read properties of undefined (reading \'theme\')' }, { status: 500 });
      }
      const page = PAGES[url.pathname];
      if (page) return new Response(Bun.file(join(PUBLIC_DIR, page)), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (url.pathname === '/app.css') return new Response(Bun.file(join(PUBLIC_DIR, 'app.css')), { headers: { 'content-type': 'text/css' } });
      if (url.pathname === '/app.js') return new Response(Bun.file(join(PUBLIC_DIR, 'app.js')), { headers: { 'content-type': 'text/javascript' } });
      return new Response('Not found', { status: 404 });
    },
  });
}

if (import.meta.main) {
  const server = startDemoServer();
  console.log(`Acme Notes demo running at http://127.0.0.1:${server.port}/`);
}
