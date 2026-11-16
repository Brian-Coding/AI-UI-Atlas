import { timingSafeEqual } from 'node:crypto';

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ ok: false, error: message, ...extra }, status);
}

export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Network guard (kept from Agent Forge, tightened for a single-purpose tool).
 *
 * The browser API can run arbitrary JavaScript in a real browser and write
 * screenshots to disk, so it must not be reachable from other machines or from
 * web pages the user happens to have open:
 *   1. The server binds to loopback only (enforced at startup).
 *   2. The Host header must be a loopback name. This blocks DNS-rebinding
 *      attacks where an attacker's domain resolves to 127.0.0.1.
 *   3. If an Origin header is present (browsers send it on cross-origin and
 *      state-changing requests), it must be this exact server's origin. A page
 *      on another port, including the app under test, is refused.
 * Non-browser clients such as curl send no Origin and are allowed.
 */
export function isRequestAllowed(req: Request, serverOrigin: string | number): boolean {
  try {
    const url = new URL(req.url);
    if (!isLoopbackHost(url.hostname)) return false;
    const expected = typeof serverOrigin === 'number' ? `http://127.0.0.1:${serverOrigin}` : serverOrigin;
    if (url.origin !== expected) return false;
    const hostHeader = req.headers.get('host');
    if (hostHeader) {
      const host = new URL(`http://${hostHeader}`).hostname;
      if (hostHeader !== new URL(expected).host) return false;
    }
    const origin = req.headers.get('origin');
    if (origin) {
      if (origin === 'null') return false;
      if (origin !== expected) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Constant-time comparison for the per-server API token. */
export function tokensMatch(expected: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function tokenFromRequest(req: Request): string | null {
  const header = req.headers.get('x-atlas-qa-token');
  if (header) return header.trim();
  const auth = req.headers.get('authorization');
  const match = auth?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : null;
}
