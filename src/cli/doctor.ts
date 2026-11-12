import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveCliBinary } from '../core/process';
import type { CliIo } from './cli';

const REPO_ROOT = resolve(import.meta.dir, '../..');

async function capture(args: string[], cwd = REPO_ROOT): Promise<{ ok: boolean; output: string }> {
  try {
    const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { ok: code === 0, output: (stdout || stderr).trim().split('\n')[0] ?? '' };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/** Locate Playwright's Chromium from Node, exactly as the worker will. */
export async function chromiumExecutable(): Promise<string | null> {
  const node = process.env.ATLAS_QA_NODE || 'node';
  const result = await capture([node, '--input-type=module', '-e', "import { chromium } from 'playwright'; console.log(chromium.executablePath());"]);
  return result.ok && result.output && existsSync(result.output) ? result.output : null;
}

/** Version checks only; never starts an LLM session. */
export async function runDoctor(io: CliIo): Promise<number> {
  let failures = 0;
  const line = (ok: boolean, label: string, detail: string) => {
    if (!ok) failures++;
    io.out(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(10)} ${detail}`);
  };
  const optional = (ok: boolean, label: string, detail: string) => io.out(`${ok ? 'ok  ' : '--  '}  ${label.padEnd(10)} ${detail}`);

  line(true, 'bun', Bun.version);
  const node = await capture([process.env.ATLAS_QA_NODE || 'node', '--version']);
  line(node.ok, 'node', node.ok ? node.output : 'not found (Node 20+ runs the Playwright worker)');
  const chromium = node.ok ? await chromiumExecutable() : null;
  line(!!chromium, 'chromium', chromium ?? 'missing: run `bun run browsers:install`');

  const claude = await capture([process.env.ATLAS_QA_CLAUDE_BIN || resolveCliBinary('claude'), '--version']);
  optional(claude.ok, 'claude', claude.ok ? claude.output : 'not found (needed for --provider claude)');
  const codex = await capture([process.env.ATLAS_QA_CODEX_BIN || resolveCliBinary('codex'), '--version']);
  optional(codex.ok, 'codex', codex.ok ? codex.output : 'not found (needed for --provider codex)');
  if (!claude.ok && !codex.ok) io.out('\nInstall and log in to at least one provider CLI to run real agents. Scripted providers work without one.');
  return failures === 0 ? 0 : 1;
}
