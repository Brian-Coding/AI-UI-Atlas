export type QaVerdict = 'pass' | 'warnings' | 'fail' | 'inconclusive';
export type QaRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type QaAssertionStatus = 'passed' | 'failed' | 'warning' | 'not_run';

export interface QaAssertion {
  id: string;
  name: string;
  status: QaAssertionStatus;
  expected?: string;
  observed?: string;
  evidenceIds: string[];
  atlasSurfaceIds?: string[];
}

export interface QaEvidence {
  id: string;
  kind: 'screenshot' | 'console' | 'network' | 'observation';
  label: string;
  /** For screenshots: absolute path returned by the browser API. */
  ref?: string;
  detail?: string;
}

export interface QaFinding {
  id: string;
  severity: 'critical' | 'major' | 'minor' | 'note';
  title: string;
  details: string;
  evidenceIds: string[];
  atlasSurfaceIds?: string[];
}

export interface QaUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** The durable record of one QA run (run.json / report.json). */
export interface QaRunRecord {
  schemaVersion: 1;
  id: string;
  url: string;
  goal: string;
  changeDescription?: string;
  provider: string;
  model?: string;
  status: QaRunStatus;
  browserSessionId: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  rerunOf?: string;
  verdict?: QaVerdict;
  summary?: string;
  assertions?: QaAssertion[];
  evidence?: QaEvidence[];
  findings?: QaFinding[];
  validationErrors?: string[];
  error?: string;
  atlasUsed?: boolean;
  atlasSurfaceIds?: string[];
  usage?: QaUsage;
}
