import type { BrowserApiClient } from '../browser/api-client';

/** What a run exposes to the agent beyond its prompts. */
export interface AgentRuntimeInfo {
  kind: 'qa' | 'atlas' | 'ask';
  /** Base URL of the local atlas-qa server (browser API), when one is running. */
  apiBase?: string;
  token?: string;
  runId?: string;
  browserSessionId?: string;
  targetUrl?: string;
  projectDir?: string;
  /** QA: run screenshot directory. Atlas: candidate shots directory. */
  screenshotDir?: string;
  /** Atlas: candidate directory the agent must write into. */
  outputDir?: string;
  /** Ask: published atlas directory. */
  atlasRoot?: string;
}

export interface AgentTask {
  systemPrompt: string;
  prompt: string;
  cwd: string;
  /** Extra directories the agent may read (Claude --add-dir). */
  addDirs?: string[];
  model?: string;
  reasoningEffort?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Raw provider events are appended here as NDJSON, when set. */
  transcriptPath?: string;
  onProgress?: (event: AgentProgressEvent) => void;
  runtime: AgentRuntimeInfo;
}

export type AgentProgressEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'status'; message: string };

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface AgentResult {
  /** The agent's final message (where result envelopes live). */
  finalText: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the provider failed (non-zero exit, spawn error, ...). */
  error?: string;
  usage?: AgentUsage;
  sessionId?: string;
}

export interface AgentProvider {
  readonly name: string;
  run(task: AgentTask): Promise<AgentResult>;
}

/** Context handed to scripted (non-LLM) agents. */
export interface ScriptedAgentContext {
  systemPrompt: string;
  prompt: string;
  cwd: string;
  runtime: AgentRuntimeInfo;
  /** HTTP client for this run's browser session (null when no server runs). */
  browser: BrowserApiClient | null;
  signal: AbortSignal;
  log(message: string): void;
}

export type ScriptedAgent = (ctx: ScriptedAgentContext) => Promise<string> | string;
