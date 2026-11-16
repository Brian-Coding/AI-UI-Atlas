import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Two independent Bun processes enter buildAtlas against the same project.
test('project lock excludes another CLI build and recovers an interrupted owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-lock-'));
  const fixture = join(root, 'runner.ts');
  const module = new URL('./atlas-runner.ts', import.meta.url).href;
  const fake = new URL('../browser/fake-driver.ts', import.meta.url).href;
  await writeFile(fixture, `
    import { buildAtlas } from ${JSON.stringify(module)};
    import { FakeBrowserDriver } from ${JSON.stringify(fake)};
    try { await buildAtlas({ projectDir: process.argv[2], url: 'http://app.test', driver: new FakeBrowserDriver(),
      provider: { name: 'fixture', async run() { console.log('ENTERED'); await Bun.stdin.text(); return { exitCode: 0, finalText: '' }; } } }); }
    catch (error) { console.log(error.message); process.exitCode = 2; }
  `);
  const spawn = () => Bun.spawn([process.execPath, fixture, root], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const first = spawn();
  try {
    const reader = first.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('ENTERED');
    reader.releaseLock();
    const second = spawn(); second.stdin.end();
    expect(await new Response(second.stdout).text()).toContain('already active');
    expect(await second.exited).toBe(2);
    first.kill('SIGKILL'); await first.exited;
    const third = spawn();
    // A stale run still requires explicit resume/discard, but the dead lock is reclaimed.
    third.stdin.end();
    const output = await new Response(third.stdout).text();
    await third.exited;
    expect(output).not.toContain('already active');
  } finally {
    try { first.kill('SIGKILL'); } catch {} await first.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
