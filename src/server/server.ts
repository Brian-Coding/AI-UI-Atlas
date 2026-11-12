import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { BrowserDriver } from '../browser/driver';
import { getDataDir } from '../core/paths';
import { createBrowserApi, type BrowserApiEvent } from './browser-api';
import { errorResponse, isLoopbackHost, isRequestAllowed } from './http';
import { SessionRegistry } from './sessions';

export type RouteHandler = (req: Request, url: URL) => Promise<Response | null> | Response | null;

export interface StartServerOptions {
  driver: BrowserDriver;
  /** 0 picks a free port. */
  port?: number;
  hostname?: string;
  /** Explicit token; a random one is generated when omitted. */
  token?: string;
  adhocScreenshotRoot?: string;
  onBrowserEvent?: (event: BrowserApiEvent) => void;
  /** Extra routes (viewer API, static UI). Tried after the browser API. */
  routes?: RouteHandler[];
  /** Bun HTML bundles served at fixed paths (the viewer UI). */
  staticRoutes?: Record<string, any>;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  sessions: SessionRegistry;
  stop(): Promise<void>;
}

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Start the local atlas-qa HTTP server: the browser API agents call, plus any
 * extra routes (the viewer). Always loopback-only.
 */
export function startServer(options: StartServerOptions): RunningServer {
  const hostname = options.hostname ?? '127.0.0.1';
  if (!isLoopbackHost(hostname)) {
    throw new Error(`Refusing to bind ${hostname}: the browser API is loopback-only (use 127.0.0.1 or localhost).`);
  }
  const token = options.token ?? generateToken();
  const sessions = new SessionRegistry();
  const browserApi = createBrowserApi({
    driver: options.driver,
    sessions,
    token,
    adhocScreenshotRoot: options.adhocScreenshotRoot ?? join(getDataDir(), 'adhoc-screenshots'),
    onEvent: options.onBrowserEvent,
  });
  const routes = options.routes ?? [];
  let port = 0;

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname,
    ...(options.staticRoutes ? { routes: options.staticRoutes } : {}),
    development: false,
    async fetch(req) {
      if (!isRequestAllowed(req, port)) return new Response('Forbidden', { status: 403 });
      const url = new URL(req.url);
      const fromBrowser = await browserApi(req, url);
      if (fromBrowser) return fromBrowser;
      for (const route of routes) {
        const response = await route(req, url);
        if (response) return response;
      }
      return url.pathname.startsWith('/api/') ? errorResponse('Not found', 404) : new Response('Not found', { status: 404 });
    },
    error(error) {
      return errorResponse(error.message || 'Internal error', 500);
    },
  });
  port = server.port ?? 0;
  const urlHost = hostname === '::1' ? '[::1]' : hostname;

  return {
    url: `http://${urlHost}:${port}`,
    port,
    token,
    sessions,
    async stop() {
      await server.stop(true);
    },
  };
}
