import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserApiClient } from '../browser/api-client';
import type { AgentProvider, AgentResult, AgentTask, ScriptedAgent } from './types';

/**
 * A deterministic, LLM-free "agent". It receives the same prompts and run
 * details a real agent would, drives the browser through the same HTTP API,
 * and returns a final message (usually containing the result envelope).
 *
 * Uses: the test suite, the demo tour, CI smoke checks, and reproducing a
 * harness bug without spending model tokens.
 */
export class ScriptedProvider implements AgentProvider {
  readonly name: string;

  constructor(private readonly agent: ScriptedAgent, name = 'scripted') {
    this.name = name;
  }

  async run(task: AgentTask): Promise<AgentResult> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(task.signal?.reason);
    if (task.signal?.aborted) onAbort();
    else task.signal?.addEventListener('abort', onAbort, { once: true });

    const { runtime } = task;
    const browser = runtime.apiBase && runtime.token && runtime.browserSessionId
      ? new BrowserApiClient(runtime.apiBase, runtime.token, runtime.browserSessionId)
      : null;
    const log = (message: string) => {
      task.onProgress?.({ type: 'text', text: message });
      if (task.transcriptPath) {
        try { appendFileSync(task.transcriptPath, `${JSON.stringify({ type: 'scripted-log', message })}\n`); } catch {}
      }
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('timeout'));
        reject(new Error(`Scripted agent exceeded ${task.timeoutMs}ms`));
      }, Math.max(1, task.timeoutMs));
    });
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Scripted agent was aborted')), { once: true });
    });

    try {
      const finalText = await Promise.race([
        Promise.resolve().then(() => this.agent({
          systemPrompt: task.systemPrompt,
          prompt: task.prompt,
          cwd: task.cwd,
          runtime,
          browser,
          signal: controller.signal,
          log,
        })),
        deadline,
        aborted,
      ]);
      return { finalText: String(finalText ?? ''), exitCode: 0, timedOut: false, aborted: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        finalText: '',
        exitCode: 1,
        timedOut,
        aborted: !timedOut && controller.signal.aborted,
        error: timedOut || controller.signal.aborted ? undefined : message,
      };
    } finally {
      if (timer) clearTimeout(timer);
      task.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** Load `script:<path>`: a module whose default export is a ScriptedAgent. */
export async function loadScriptedProvider(modulePath: string): Promise<ScriptedProvider> {
  const absolute = resolve(modulePath);
  const mod = await import(pathToFileURL(absolute).href);
  const agent = mod.default ?? mod.agent;
  if (typeof agent !== 'function') {
    throw new Error(`${modulePath} must export a default function (ctx) => finalMessage`);
  }
  return new ScriptedProvider(agent, `script:${modulePath}`);
}
