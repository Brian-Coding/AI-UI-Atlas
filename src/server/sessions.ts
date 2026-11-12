import { resolve } from 'node:path';
import { isSafeId } from '../core/paths';

/**
 * A browser session granted to one run. The grant decides where that
 * session's screenshots are written, so an agent can never choose an
 * arbitrary output directory.
 */
export interface SessionGrant {
  sessionId: string;
  kind: 'qa' | 'atlas' | 'adhoc';
  /** Absolute directory that receives this session's screenshots. */
  screenshotDir: string;
  runId?: string;
}

export class SessionRegistry {
  private readonly grants = new Map<string, SessionGrant>();

  register(grant: SessionGrant): SessionGrant {
    if (!isSafeId(grant.sessionId)) throw new Error(`Invalid browser session ID: ${grant.sessionId}`);
    if (grant.runId !== undefined && !isSafeId(grant.runId)) throw new Error(`Invalid run ID: ${grant.runId}`);
    const normalized = { ...grant, screenshotDir: resolve(grant.screenshotDir) };
    this.grants.set(grant.sessionId, normalized);
    return normalized;
  }

  unregister(sessionId: string): void {
    this.grants.delete(sessionId);
  }

  get(sessionId: string): SessionGrant | undefined {
    return this.grants.get(sessionId);
  }

  list(): SessionGrant[] {
    return [...this.grants.values()];
  }
}
