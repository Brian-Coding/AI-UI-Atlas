import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, win32 as win32Path } from 'node:path';
import { resolveCliBinary } from '../core/process';
import { runCliAgent } from './cli-process';
import { sanitizeCliText, summarizeToolInput } from './stream-utils';
import type { AgentProvider, AgentResult, AgentTask, AgentUsage } from './types';

export function resolveCodexLaunchCommand(
  codexBin: string,
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
): string[] {
  if (platform !== 'win32' || extname(codexBin).toLowerCase() !== '.cmd') return [codexBin];
  const entrypoint = win32Path.resolve(win32Path.dirname(codexBin), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return pathExists(entrypoint) ? [resolveCliBinary('node'), entrypoint] : [codexBin];
}

/** Codex reads `model_reasoning_effort`; the legacy `extra_high` spelling maps to `xhigh`. */
export function codexReasoningConfigArg(level?: string): string {
  const normalized = level === 'extra_high' ? 'xhigh' : (level || 'high');
  return `model_reasoning_effort="${normalized}"`;
}

/**
 * codex exec --json --skip-git-repo-check --output-last-message <file>
 *            --dangerously-bypass-approvals-and-sandbox
 *            [-m <model>] -c model_reasoning_effort="<level>" -C <cwd> -
 * The prompt (system context + task) is piped through stdin (`-`), so large
 * prompts never hit argv limits.
 */
export function buildCodexArgs(
  command: string[],
  task: Pick<AgentTask, 'cwd' | 'model' | 'reasoningEffort'>,
  outputPath: string,
): string[] {
  const args = [
    ...command,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--output-last-message', outputPath,
    // Headless runs cannot answer approval prompts; see docs/security.md.
    '--dangerously-bypass-approvals-and-sandbox',
  ];
  if (task.model) args.push('-m', task.model);
  args.push('-c', codexReasoningConfigArg(task.reasoningEffort));
  args.push('-C', task.cwd);
  args.push('-');
  return args;
}

/** Codex has no --append-system-prompt; prepend the system context with clear markers. */
export function buildCodexStdin(task: Pick<AgentTask, 'systemPrompt' | 'prompt' | 'addDirs'>): string {
  const dirs = (task.addDirs ?? []).length
    ? `\n\nAdditional directories you may read: ${(task.addDirs ?? []).join(', ')}`
    : '';
  if (!task.systemPrompt) return task.prompt + dirs;
  return [
    '=== SYSTEM CONTEXT (from atlas-qa; these instructions are binding) ===',
    task.systemPrompt + dirs,
    '=== END SYSTEM CONTEXT ===',
    '',
    '=== TASK ===',
    task.prompt,
  ].join('\n');
}

export interface CodexStreamState {
  lastAgentMessage: string;
  sessionId?: string;
  usage: AgentUsage;
  error?: string;
}

export function createCodexStreamState(): CodexStreamState {
  return { lastAgentMessage: '', usage: {} };
}

function itemText(item: any): string {
  if (typeof item?.text === 'string') return item.text;
  if (typeof item?.message === 'string') return item.message;
  if (Array.isArray(item?.content)) return item.content.map((part: any) => part?.text ?? '').join('');
  return '';
}

/** Fold one `codex exec --json` event into the run state. */
export function handleCodexEvent(event: any, state: CodexStreamState, onProgress?: AgentTask['onProgress']): void {
  if (!event || typeof event !== 'object') return;
  const item = event.item;
  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    state.sessionId = event.thread_id;
    return;
  }
  if (event.type === 'item.started' && item?.type === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : '';
    onProgress?.({ type: 'tool', name: 'shell', summary: summarizeToolInput('shell', { command }) });
    return;
  }
  if (event.type === 'item.started' && (item?.type === 'mcp_tool_call' || item?.type === 'web_search')) {
    const name = String(item.tool ?? item.type);
    onProgress?.({ type: 'tool', name, summary: summarizeToolInput(name, item.arguments ?? { query: item.query }) });
    return;
  }
  if (event.type === 'item.completed' && item?.type === 'agent_message') {
    const text = itemText(item);
    if (text) {
      state.lastAgentMessage = text;
      const clean = sanitizeCliText(text).trim();
      if (clean) onProgress?.({ type: 'text', text: clean });
    }
    return;
  }
  if (event.type === 'item.completed' && item?.type === 'reasoning') {
    const text = sanitizeCliText(itemText(item)).trim();
    if (text) onProgress?.({ type: 'status', message: text });
    return;
  }
  if (event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
    const usage = event.usage;
    state.usage.inputTokens = (state.usage.inputTokens ?? 0) + (Number(usage.input_tokens) || 0);
    state.usage.outputTokens = (state.usage.outputTokens ?? 0)
      + (Number(usage.output_tokens) || 0) + (Number(usage.reasoning_output_tokens) || 0);
    return;
  }
  if (event.type === 'task_complete' && typeof event.last_agent_message === 'string' && event.last_agent_message) {
    state.lastAgentMessage = event.last_agent_message;
    return;
  }
  if (event.type === 'turn.failed') {
    state.error = String(event.error?.message ?? event.message ?? 'Codex turn failed');
    return;
  }
  if ((event.type === 'error' && typeof event.message === 'string')
    || (event.type === 'item.completed' && item?.type === 'error')) {
    const message = String(event.message ?? item?.message ?? '');
    // Reconnect/fallback notices are progress, not failures.
    if (/^Reconnecting|^Falling back from WebSockets?/i.test(message.trim())) {
      onProgress?.({ type: 'status', message });
      return;
    }
    if (message) state.error = message;
  }
}

export class CodexProvider implements AgentProvider {
  readonly name = 'codex';

  constructor(private readonly binary = process.env.ATLAS_QA_CODEX_BIN || '') {}

  async run(task: AgentTask): Promise<AgentResult> {
    const command = resolveCodexLaunchCommand(this.binary || resolveCliBinary('codex'));
    const scratch = mkdtempSync(join(tmpdir(), 'atlas-qa-codex-'));
    const outputPath = join(scratch, 'last-message.txt');
    const state = createCodexStreamState();
    try {
      const outcome = await runCliAgent({
        args: buildCodexArgs(command, task, outputPath),
        stdinText: buildCodexStdin(task),
        cwd: task.cwd,
        timeoutMs: task.timeoutMs,
        signal: task.signal,
        transcriptPath: task.transcriptPath,
        onEvent: event => handleCodexEvent(event, state, task.onProgress),
      });
      let finalText = '';
      try { finalText = readFileSync(outputPath, 'utf8').trim(); } catch {}
      if (!finalText) finalText = state.lastAgentMessage;
      let error = state.error;
      if (!error && outcome.exitCode !== 0 && !outcome.timedOut && !outcome.aborted) {
        error = outcome.stderr || `Codex CLI exited with code ${outcome.exitCode} and no output`;
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
      const message = error instanceof Error ? error.message : String(error);
      return { finalText: '', exitCode: null, timedOut: false, aborted: false, error: `Could not start Codex CLI: ${message}` };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
