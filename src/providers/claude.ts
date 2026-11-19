import { reportedNumber, reportedSum } from './usage';
import { existsSync } from 'node:fs';
import { extname, win32 as win32Path } from 'node:path';
import { ArgvTooLongError, resolveCliBinary } from '../core/process';
import { redactSecrets } from '../core/redact';
import { runCliAgent } from './cli-process';
import { sanitizeCliText, summarizeToolInput } from './stream-utils';
import type { AgentProvider, AgentResult, AgentTask, AgentUsage } from './types';

/**
 * Resolve the argv prefix for the Claude CLI. On Windows the npm `.cmd` shim
 * is bypassed in favor of its JS entry point to avoid cmd.exe quoting and
 * command-line-length problems (kept from the Agent Forge adapter).
 */
export function resolveClaudeLaunchCommand(
  claudeBin: string,
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
): string[] {
  if (platform !== 'win32' || extname(claudeBin).toLowerCase() !== '.cmd') return [claudeBin];
  const entrypoint = win32Path.resolve(
    win32Path.dirname(claudeBin),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'cli.js',
  );
  return pathExists(entrypoint) ? [resolveCliBinary('node'), entrypoint] : [claudeBin];
}

/**
 * claude --print --output-format stream-json --verbose
 *        --dangerously-skip-permissions
 *        --append-system-prompt <system prompt>
 *        [--add-dir <dir>]... [--model <model>]
 * The task prompt is written to stdin.
 */
export function buildClaudeArgs(command: string[], task: Pick<AgentTask, 'systemPrompt' | 'addDirs' | 'model'>): string[] {
  const args = [
    ...command,
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    // Headless runs cannot answer permission prompts; the agent must be able
    // to run curl and read screenshots. See docs/security.md.
    '--dangerously-skip-permissions',
  ];
  for (const dir of task.addDirs ?? []) {
    if (existsSync(dir)) args.push('--add-dir', dir);
  }
  if (task.systemPrompt) args.push('--append-system-prompt', task.systemPrompt);
  if (task.model) args.push('--model', task.model);
  return args;
}

export interface ClaudeStreamState {
  finalText: string;
  lastAssistantText: string;
  sessionId?: string;
  usage: AgentUsage;
  error?: string;
}

export function createClaudeStreamState(): ClaudeStreamState {
  return { finalText: '', lastAssistantText: '', usage: {} };
}

/**
 * Fold one `stream-json` event into the run state. Simplified from the Agent
 * Forge adapter: we need progress, usage, and the final result text, not
 * token-level streaming.
 */
export function handleClaudeEvent(
  event: any,
  state: ClaudeStreamState,
  onProgress?: AgentTask['onProgress'],
): void {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
    state.sessionId = event.session_id;
    return;
  }
  if (event.type === 'assistant') {
    const isSubagent = typeof event.parent_tool_use_id === 'string' && !!event.parent_tool_use_id;
    const content = event.message?.content;
    if (!Array.isArray(content)) return;
    const text = content
      .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join('');
    if (text && !isSubagent) {
      state.lastAssistantText = text;
      const clean = sanitizeCliText(text).trim();
      if (clean) onProgress?.({ type: 'text', text: clean });
    }
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const name = String(block.name ?? 'tool');
      onProgress?.({ type: 'tool', name, summary: summarizeToolInput(block.input) });
    }
    return;
  }
  if (event.type === 'result') {
    const resultText = typeof event.result === 'string' ? event.result : '';
    const isError = event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error'));
    if (isError) state.error = resultText || `Claude reported ${event.subtype ?? 'an error'}`;
    else if (resultText) state.finalText = resultText;
    state.usage.costUsd = reportedNumber(event.total_cost_usd);
    const usage = event.usage;
    if (usage && typeof usage === 'object') {
      state.usage.inputTokens = reportedSum(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens);
      state.usage.outputTokens = reportedNumber(usage.output_tokens);
    }
    return;
  }
  if (event.type === 'error' && typeof event.message === 'string') {
    state.error = event.message;
  }
}

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude';

  constructor(private readonly binary = process.env.ATLAS_QA_CLAUDE_BIN || '') {}

  async run(task: AgentTask): Promise<AgentResult> {
    const command = resolveClaudeLaunchCommand(this.binary || resolveCliBinary('claude'));
    const args = buildClaudeArgs(command, task);
    const state = createClaudeStreamState();
    try {
      const outcome = await runCliAgent({
        args,
        stdinText: task.prompt,
        cwd: task.cwd,
        timeoutMs: task.timeoutMs,
        signal: task.signal,
        transcriptPath: task.transcriptPath,
        redactValues: task.runtime.token ? [task.runtime.token] : [],
        onEvent: event => handleClaudeEvent(event, state, task.onProgress),
      });
      const finalText = state.finalText || state.lastAssistantText;
      let error = outcome.detached ? 'Provider descendant cleanup could not be confirmed' : state.error;
      if (!error && outcome.exitCode !== 0 && !outcome.timedOut && !outcome.aborted) {
        error = outcome.stderr || `Claude CLI exited with code ${outcome.exitCode} and no output`;
      }
      return {
        finalText,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        error,
        usage: state.usage,
        sessionId: state.sessionId,
      };
    } catch (error) {
      const message = error instanceof ArgvTooLongError || error instanceof Error ? error.message : String(error);
      return { finalText: '', exitCode: null, timedOut: false, aborted: false,
        error: redactSecrets(`Could not start Claude CLI: ${message}`, task.runtime.token ? [task.runtime.token] : []) };
    }
  }
}
