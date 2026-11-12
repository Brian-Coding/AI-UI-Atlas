import { WorkerBrowserDriver } from '../browser/worker-driver';
import { resolveProvider } from '../providers/registry';
import { startServer } from '../server/server';
import { createViewerApi } from '../server/viewer-api';
import type { CliIo } from './cli';

export interface ServeOptions {
  projectDir: string;
  port: number;
  allowAsk: boolean;
  provider?: string;
  model?: string;
  io: CliIo;
  /** Resolves when the server should stop (tests); defaults to SIGINT/SIGTERM. */
  until?: Promise<void>;
}

export async function runServe(options: ServeOptions): Promise<number> {
  const viewer = (await import('../viewer/index.html')).default;
  const driver = options.io.driver ?? new WorkerBrowserDriver();
  const server = startServer({
    driver,
    port: options.port,
    staticRoutes: { '/': viewer },
    routes: [createViewerApi({
      projectDir: options.projectDir,
      askProvider: options.allowAsk ? () => resolveProvider(options.provider) : undefined,
      askModel: options.model,
    })],
  });
  options.io.out(`Viewer for ${options.projectDir}`);
  options.io.out(`  ${server.url}/`);
  if (options.allowAsk) options.io.out('  "Ask LLM" is enabled and will use your provider CLI.');
  options.io.out('Press Ctrl+C to stop.');

  await (options.until ?? new Promise<void>(resolveStop => {
    const signal = options.io.signal;
    if (signal) signal.addEventListener('abort', () => resolveStop(), { once: true });
    else process.once('SIGINT', () => resolveStop());
    process.once('SIGTERM', () => resolveStop());
  }));
  await server.stop();
  await driver.close();
  return 0;
}
