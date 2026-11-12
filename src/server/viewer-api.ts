// Read-mostly JSON API behind the local viewer UI: the published atlas, the
// current atlas run, QA runs, and their screenshots. File serving is
// sandboxed to the atlas directory and each run's screenshot folder.

import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { askAtlas, AtlasQueryBusyError } from '../atlas/atlas-ask';
import { AtlasAnswerValidationError } from '../atlas/atlas-query-result';
import { readAtlasRunState } from '../atlas/atlas-runner';
import { loadPublishedAtlas, queryAtlas } from '../atlas/atlas-search';
import { readSurfaceVerifications } from '../atlas/verifications';
import { readJsonBody, RequestBodyError } from '../core/request-body';
import { isPathInside, isSafeId, projectPaths } from '../core/paths';
import type { AgentProvider } from '../providers/types';
import { RunStore } from '../qa/run-store';
import { errorResponse, jsonResponse } from './http';

export interface ViewerApiOptions {
  projectDir: string;
  /** Enables POST /api/atlas/ask. Without it the endpoint returns 501. */
  askProvider?: () => Promise<AgentProvider>;
  askModel?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/** Serve a file only if it resolves (after symlinks) inside `root`. */
async function serveSandboxed(root: string, relPath: string, allowed: string[]): Promise<Response> {
  const ext = extname(relPath).toLowerCase();
  if (!allowed.includes(ext)) return errorResponse('File type not allowed', 400);
  const requested = resolve(root, relPath);
  if (!isPathInside(root, requested)) return errorResponse('Path outside allowed root', 403);
  if (!existsSync(requested)) return errorResponse('Not found', 404);
  try {
    if (!isPathInside(realpathSync(root), realpathSync(requested))) return errorResponse('Path resolves outside allowed root', 403);
  } catch {
    return errorResponse('Not found', 404);
  }
  return new Response(Bun.file(requested), {
    headers: { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' },
  });
}

export function createViewerApi(options: ViewerApiOptions) {
  const projectDir = resolve(options.projectDir);
  const paths = projectPaths(projectDir);
  const store = new RunStore(paths.runsDir);

  return async function handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (!path.startsWith('/api/') || path.startsWith('/api/browser/')) return null;
    try {
      if (req.method === 'GET' && path === '/api/project') {
        const manifestPath = join(paths.atlasRoot, 'manifest.json');
        const manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : null;
        return jsonResponse({
          name: basename(projectDir),
          projectDir,
          atlas: { published: existsSync(join(paths.atlasRoot, 'atlas.json')), manifest },
          atlasRun: await readAtlasRunState(projectDir),
          askEnabled: !!options.askProvider,
        });
      }
      if (req.method === 'GET' && path === '/api/atlas/graph') {
        const { graph } = await loadPublishedAtlas(projectDir);
        return jsonResponse(graph);
      }
      if (req.method === 'GET' && path === '/api/atlas/file') {
        const relPath = url.searchParams.get('relPath');
        if (!relPath) return errorResponse('relPath required');
        return serveSandboxed(paths.atlasRoot, relPath, ['.md', '.json', '.png', '.jpg', '.jpeg']);
      }
      if (req.method === 'GET' && path === '/api/atlas/query') {
        const q = url.searchParams.get('q')?.trim();
        if (!q) return errorResponse('q required');
        const { graph } = await loadPublishedAtlas(projectDir);
        return jsonResponse(queryAtlas(graph, q));
      }
      if (req.method === 'GET' && path === '/api/atlas/verifications') {
        return jsonResponse(await readSurfaceVerifications(projectDir));
      }
      if (req.method === 'POST' && path === '/api/atlas/ask') {
        if (!options.askProvider) return errorResponse('Ask Atlas is disabled. Start the viewer with --allow-ask to enable LLM answers.', 501);
        const body: any = await readJsonBody(req, 8_000);
        if (typeof body?.question !== 'string' || !body.question.trim()) return errorResponse('question is required');
        const answer = await askAtlas({
          projectDir,
          question: body.question,
          provider: await options.askProvider(),
          model: options.askModel,
        });
        return jsonResponse(answer);
      }
      if (req.method === 'GET' && path === '/api/qa/runs') {
        const runs = await store.list();
        return jsonResponse(runs.map(run => ({
          id: run.id, url: run.url, goal: run.goal, status: run.status, verdict: run.verdict,
          summary: run.summary, provider: run.provider, createdAt: run.createdAt, finishedAt: run.finishedAt,
          findingCount: run.findings?.length ?? 0,
        })));
      }
      const runMatch = path.match(/^\/api\/qa\/runs\/([^/]+)(?:\/(report|screenshots)(?:\/([^/]+))?)?$/);
      if (req.method === 'GET' && runMatch) {
        const [, id, sub, file] = runMatch;
        if (!isSafeId(id)) return errorResponse('Invalid run ID');
        const run = await store.get(id!);
        if (!run) return errorResponse('Run not found', 404);
        if (!sub) return jsonResponse(run);
        if (sub === 'report') {
          return new Response(await store.readFile(id!, 'report.md') ?? '', { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
        }
        if (sub === 'screenshots' && file) {
          return serveSandboxed(store.screenshotsDir(id!), decodeURIComponent(file), ['.png']);
        }
      }
      return null;
    } catch (error) {
      if (error instanceof RequestBodyError) return errorResponse(error.message, error.status);
      if (error instanceof AtlasQueryBusyError) return errorResponse(error.message, 409);
      if (error instanceof AtlasAnswerValidationError) {
        return errorResponse('The analyst returned an ungrounded answer', 422, { validationErrors: error.errors });
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, message.startsWith('No published UI Atlas') ? 404 : 500);
    }
  };
}
