import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createCliEnv,
  createProcessUnwindSignal,
  killProcessTree,
  safeSpawn,
  waitForOperationOrUnwind,
  waitForProcessExit,
} from '../core/process';
import { flushNdjsonLeftover, parseNdjsonLines } from './stream-utils';

export interface CliRunOptions {
  args: string[];
  stdinText: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  /** Called for every parsed NDJSON line on stdout. */
  onEvent(event: any): void;
  /** Raw stdout lines are appended here when set. */
  transcriptPath?: string;
  redactValues?: string[];
}

export interface CliRunOutcome {
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Termination could not be confirmed; the process may still be alive. */
  detached: boolean;
}

const STDERR_TAIL_CHARS = 64_000;
const MAX_LINE_CHARS = 10_000_000;

/**
 * Spawn a headless agent CLI, feed it one prompt on stdin, and stream its
 * NDJSON stdout. Adapted from the Agent Forge Claude/Codex adapters' process
 * handling: bounded tree-kill on timeout/abort, a stderr tail, and an unwind
 * signal so a process that refuses to die cannot hang the caller.
 */
export async function runCliAgent(options: CliRunOptions): Promise<CliRunOutcome> {
  const unwind = createProcessUnwindSignal();
  let timedOut = false;
  let aborted = false;
  let detached = false;
  let termination: Promise<void> | null = null;

  const transcript = (line: string) => {
    if (!options.transcriptPath) return;
    try {
      mkdirSync(dirname(options.transcriptPath), { recursive: true });
      for (const value of options.redactValues ?? []) if (value) line = line.split(value).join('<redacted-token>');
      appendFileSync(options.transcriptPath, line.endsWith('\n') ? line : `${line}\n`);
    } catch { /* transcripts are best effort */ }
  };

  const proc = safeSpawn(options.args, {
    cwd: options.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: createCliEnv(options.env ?? {}),
  });

  const terminate = (): Promise<void> => {
    if (termination) return termination;
    termination = (async () => {
      // Ask nicely first so the CLI can flush, then take down the whole tree.
      if (process.platform !== 'win32') {
        try { proc.kill('SIGINT'); } catch {}
        await waitForProcessExit(proc, 1500);

      }
      const result = await killProcessTree(proc).catch(() => null);
      if (!result?.rootExited || !result.treeKill.succeeded) detached = true;
      unwind.trigger();
    })();
    return termination;
  };

  const timer = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, Math.max(1, options.timeoutMs));
  const onAbort = () => {
    aborted = true;
    void terminate();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    try {
      proc.stdin.write(options.stdinText.endsWith('\n') ? options.stdinText : `${options.stdinText}\n`);
      proc.stdin.end();
    } catch {
      void terminate();
    }

    const stderrPromise = (async () => {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let tail = '';
      try {
        while (true) {
          const next = await waitForOperationOrUnwind(reader.read(), unwind);
          if (next.status === 'unwound' || next.value.done) break;
          tail += decoder.decode(next.value.value, { stream: true });
          if (tail.length > STDERR_TAIL_CHARS) tail = tail.slice(-STDERR_TAIL_CHARS);
        }
      } catch { /* stream closed */ } finally {
        if (unwind.isTriggered()) void reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch {}
      }
      return tail + decoder.decode();
    })();

    const handle = (event: any) => {
      try { options.onEvent(event); } catch { /* a bad event must not kill the run */ }
    };
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let leftover = '';
    try {
      while (true) {
        const next = await waitForOperationOrUnwind(reader.read(), unwind);
        if (next.status === 'unwound' || next.value.done) break;
        const text = decoder.decode(next.value.value, { stream: true });
        leftover += text;
        const lines = leftover.split('\n');
        for (const line of lines.slice(0, -1)) if (line.trim()) transcript(line);
        leftover = parseNdjsonLines(leftover, handle);
        if (leftover.length > MAX_LINE_CHARS) leftover = '';
      }
      if (leftover.trim()) transcript(leftover);
      flushNdjsonLeftover(leftover, handle);
    } finally {
      if (unwind.isTriggered()) void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch {}
    }

    const exit = await waitForOperationOrUnwind(proc.exited, unwind);
    if (termination) await termination;
    else if (process.platform !== 'win32') {
      const cleanup = await killProcessTree(proc);
      if (!cleanup.treeKill.succeeded) detached = true;
    }
    const stderr = (await stderrPromise).trim();
    return {
      exitCode: exit.status === 'completed' ? exit.value : null,
      stderr,
      timedOut,
      aborted,
      detached,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (termination) await termination;
  }
}
