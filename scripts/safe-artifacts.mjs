import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, parse, resolve, sep } from 'node:path';

/** Canonicalize the project first; all generated descendants must be real directories. */
export async function ensureSafeDirectory(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Artifact directory contains a symlink or non-directory');
  }
  return realpath(absolute);
}

/** Exclusive creation refuses existing files, symlinks, and junction destinations. */
export async function writeExclusiveArtifact(path, bytes) {
  await ensureSafeDirectory(dirname(path));
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}

/** Generated containers own this marker; atomic rename never follows a destination link. */
export async function ensureIgnoredDirectory(path) {
  const root = await ensureSafeDirectory(path);
  const { randomUUID } = await import('node:crypto');
  const { rename, unlink } = await import('node:fs/promises');
  const marker = resolve(root, '.gitignore');
  try {
    const existing = await lstat(marker);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('Unsafe generated ignore marker');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = resolve(root, `.ignore-${randomUUID()}.tmp`);
  try {
    await writeExclusiveArtifact(temporary, '# Generated artifacts stay local.\n*\n');
    await rename(temporary, marker);
  } finally { await unlink(temporary).catch(() => {}); }
  return root;
}
