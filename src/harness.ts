import type { BrowserDriver } from './browser/driver';
import { WorkerBrowserDriver } from './browser/worker-driver';
import type { BrowserApiEvent } from './server/browser-api';
import { startServer, type RunningServer } from './server/server';

/**
 * A browser driver plus the local server that exposes it to agents. Runs can
 * share one (the `serve` command) or open a private one for their lifetime
 * (the CLI). Whatever the harness created, it also closes.
 */
export interface Harness {
  driver: BrowserDriver;
  server: RunningServer;
  close(): Promise<void>;
}

export interface HarnessOptions {
  driver?: BrowserDriver;
  /** Reuse a running server. Its driver must be the `driver` passed here. */
  server?: RunningServer;
  headed?: boolean;
  onBrowserEvent?: (event: BrowserApiEvent) => void;
}

export function openHarness(options: HarnessOptions = {}): Harness {
  if (options.server && !options.driver) throw new Error('A shared server must be passed together with its driver');
  const ownsDriver = !options.driver;
  const driver = options.driver ?? new WorkerBrowserDriver({ env: options.headed ? { ATLAS_QA_HEADED: '1' } : {} });
  const ownsServer = !options.server;
  const server = options.server ?? startServer({ driver, onBrowserEvent: options.onBrowserEvent });
  return {
    driver,
    server,
    async close() {
      if (ownsServer) await server.stop().catch(() => {});
      if (ownsDriver) await driver.close().catch(() => {});
    },
  };
}
