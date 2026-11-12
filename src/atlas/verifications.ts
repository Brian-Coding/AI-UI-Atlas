import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../core/atomic-file';
import { ensureStateDir, projectPaths } from '../core/paths';

export interface SurfaceVerification {
  lastPassedAt: string;
  runId: string;
}

export type SurfaceVerificationMap = Record<string, SurfaceVerification>;

export async function readSurfaceVerifications(projectDir: string): Promise<SurfaceVerificationMap> {
  try {
    const parsed = JSON.parse(await readFile(projectPaths(projectDir).surfaceVerificationsFile, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Surface IDs present in the published atlas.json, or null when there is none. */
export async function publishedSurfaceIds(projectDir: string): Promise<Set<string> | null> {
  try {
    const graph = JSON.parse(await readFile(join(projectPaths(projectDir).atlasRoot, 'atlas.json'), 'utf8')) as {
      surfaces?: Array<{ id?: unknown }>;
    };
    return new Set((graph.surfaces ?? []).map(surface => surface.id).filter((id): id is string => typeof id === 'string'));
  } catch {
    return null;
  }
}

/** Record that a passed QA assertion exercised these surfaces. */
export async function recordSurfaceVerifications(
  projectDir: string,
  surfaceIds: Iterable<string>,
  runId: string,
  at = new Date(),
): Promise<string[]> {
  const ids = [...new Set(surfaceIds)];
  if (ids.length === 0) return [];
  await ensureStateDir(projectDir);
  const current = await readSurfaceVerifications(projectDir);
  for (const id of ids) current[id] = { lastPassedAt: at.toISOString(), runId };
  await atomicWriteFile(projectPaths(projectDir).surfaceVerificationsFile, JSON.stringify(current, null, 2));
  return ids;
}

/** Drop verification entries whose surfaces no longer exist in the atlas. */
export async function retainPublishedVerifications(projectDir: string): Promise<void> {
  const allowed = await publishedSurfaceIds(projectDir);
  if (!allowed) return;
  const current = await readSurfaceVerifications(projectDir);
  const kept = Object.fromEntries(Object.entries(current).filter(([id]) => allowed.has(id)));
  if (Object.keys(kept).length === Object.keys(current).length) return;
  await atomicWriteFile(projectPaths(projectDir).surfaceVerificationsFile, JSON.stringify(kept, null, 2));
}
