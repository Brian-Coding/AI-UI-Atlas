import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { killProcessTree, waitForProcessExit } from '../src/core/process';

const root = resolve(process.argv[2] || process.cwd());
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const startup: number[] = [], builds: number[] = [], requests: number[] = [];
const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(join(root, path)).href);

for (let i = 0; i < 7; i++) {
  const state = await mkdtemp(join(tmpdir(), 'atlas-perf-'));
  try {
    const socket = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = socket.port!;
    await socket.stop(true);
    const entry = join(state, 'entry.ts');
    await writeFile(entry, `
      import viewer from ${moduleUrl('src/viewer/index.html')};
      import { startServer } from ${moduleUrl('src/server/server.ts')};
      import { FakeBrowserDriver } from ${moduleUrl('src/browser/fake-driver.ts')};
      const server = startServer({
        driver: new FakeBrowserDriver(), port: ${port}, staticRoutes: { '/': viewer },
        routes: [(_req, url) => url.pathname === '/ready' ? new Response('ready') : null],
      });
      await Bun.stdin.text();
      await server.stop();
    `);
    const startedAt = performance.now();
    const proc = Bun.spawn([process.execPath, entry], {
      cwd: state, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
      detached: process.platform !== 'win32',
      env: { ...process.env, ATLAS_QA_DATA_DIR: join(state, 'user-data') },
    });
    try {
      const url = `http://127.0.0.1:${port}/ready`;
      let ready = false;
      for (let n = 0; n < 1000; n++) {
        if (proc.exitCode !== null) throw new Error(`Benchmark server exited with code ${proc.exitCode}`);
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
          if (response.ok && await response.text() === 'ready') { ready = true; break; }
        } catch { /* Retry while the server starts. */ }
        await Bun.sleep(5);
      }
      if (!ready) throw new Error('Benchmark server did not become ready');
      startup.push(performance.now() - startedAt);
      for (let n = 0; n < 10; n++) {
        const startedAt = performance.now();
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (!response.ok || await response.text() !== 'ready') throw new Error('Benchmark readiness request failed');
        requests.push(performance.now() - startedAt);
      }
      proc.stdin.end();
      const exit = await waitForProcessExit(proc, 5000);
      if (exit.status !== 'exited' || exit.exitCode !== 0) throw new Error('Benchmark server did not stop cleanly');
    } finally {
      if (proc.exitCode === null) await killProcessTree(proc);
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }

  const startedAt = performance.now();
  const result = await Bun.build({ entrypoints: [join(root, 'src/viewer/index.html')], target: 'browser', minify: true });
  if (!result.success) throw new Error('Benchmark build failed');
  builds.push(performance.now() - startedAt);
}
console.log(JSON.stringify({ project: 'atlas', startup_ms: median(startup), build_ms: median(builds), request_ms: median(requests), samples: 7,
  rawSamples: { startup_ms: startup, build_ms: builds, request_ms: requests } }));
