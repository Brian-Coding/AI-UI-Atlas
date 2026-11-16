import { ensureSafeDirectory, ensureIgnoredDirectory } from '../../scripts/safe-artifacts.mjs';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Folder (inside the project under test) holding run data and local state. */
export const STATE_DIR_NAME = '.atlas-qa';
/** Published Atlas location, relative to the project root. */
export const ATLAS_RELATIVE_ROOT = 'docs/ui-atlas';

export const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function safeSegment(value: string, fallback: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
  return safe || fallback;
}

/**
 * Machine-wide data directory for things that do not belong to one project
 * (ad-hoc screenshots taken outside a run, Ask Atlas scratch space).
 */
export function getDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ATLAS_QA_DATA_DIR?.trim();
  if (override) return resolve(override);
  if (process.platform === 'win32' && env.LOCALAPPDATA) return resolve(join(env.LOCALAPPDATA, 'ui-atlas-qa'));
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return resolve(join(xdg, 'ui-atlas-qa'));
  return resolve(join(homedir(), '.local', 'share', 'ui-atlas-qa'));
}

export interface ProjectPaths {
  projectRoot: string;
  stateDir: string;
  runsDir: string;
  atlasRunFile: string;
  surfaceVerificationsFile: string;
  atlasRoot: string;
}

export function projectPaths(projectDir: string): ProjectPaths {
  const projectRoot = realpathSync(projectDir);
  const stateDir = join(projectRoot, STATE_DIR_NAME);
  return {
    projectRoot,
    stateDir,
    runsDir: join(stateDir, 'runs'),
    atlasRunFile: join(stateDir, 'atlas-run.json'),
    surfaceVerificationsFile: join(stateDir, 'surface-verifications.json'),
    atlasRoot: join(projectRoot, ...ATLAS_RELATIVE_ROOT.split('/')),
  };
}

/**
 * Create the project state folder. It ignores itself so run artifacts never
 * end up in the project's git history by accident.
 */
export async function ensureStateDir(projectDir: string): Promise<ProjectPaths> {
  const paths = projectPaths(projectDir);
  await ensureSafeDirectory(paths.runsDir);
  await ensureIgnoredDirectory(paths.stateDir);
  return paths;
}

/** Render a path with forward slashes (prompts and reports read better). */
export function slashPath(path: string): string {
  return path.replace(/\\/g, '/');
}
