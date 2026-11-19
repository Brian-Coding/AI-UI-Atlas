import { afterEach, expect, test } from 'bun:test';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDirs, tempDir } from '../../tests/helpers';
import { runCliAgent } from './cli-process';
import { buildClaudeArgs, createClaudeStreamState, handleClaudeEvent } from './claude';
import { buildCodexArgs, CodexProvider, createCodexStreamState, handleCodexEvent } from './codex';

afterEach(cleanupTempDirs);

test('subprocess runner streams UTF-8 NDJSON, tolerates noise, and redacts saved tokens', async () => {
  const cwd = tempDir();
  const transcriptPath = join(cwd, 'events.ndjson');
  const events: unknown[] = [];
  const source = `process.stdin.resume(); process.stdin.on('end', () => {
    console.log('not JSON');
    console.log(JSON.stringify({type:'message',text:'caf\u00e9 local-test-token'}));
    process.stdout.write(JSON.stringify({type:'final',text:'done'}));
  });`;
  const result = await runCliAgent({ args: [process.execPath, '-e', source], stdinText: 'task', cwd, timeoutMs: 5000,
    onEvent: event => events.push(event), transcriptPath, redactValues: ['local-test-token'] });
  expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false });
  expect(events).toEqual([{ type: 'message', text: 'café <redacted-token>' }, { type: 'final', text: 'done' }]);
  const saved = await readFile(transcriptPath, 'utf8');
  expect(saved).not.toContain('local-test-token');
  expect(saved).toContain('<redacted-token>');
});

test.each(['claude', 'codex'])('%s redacts before tool-summary truncation, including transcripts and stderr', async provider => {
  const cwd = tempDir();
  const transcriptPath = join(cwd, 'events.ndjson');
  const token = 'synthetic-scoped-token-'.repeat(8);
  const command = `H='-H content-type:application/json -H x-atlas-qa-token:${token}' curl /api`;
  const progress: unknown[] = [];
  const state = provider === 'claude' ? createClaudeStreamState() : createCodexStreamState();
  const events = provider === 'claude'
    ? [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } },
      { type: 'text', text: `Token: ${token}; Authorization: Bearer synthetic-auth-value` }] } }]
    : [{ type: 'item.started', item: { type: 'command_execution', command } },
      { type: 'item.completed', item: { type: 'reasoning', text: `Token: ${token}; Authorization: Bearer synthetic-auth-value` } }];
  const source = `process.stdin.resume(); process.stdin.on('end',()=>{
    for(const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));
    process.stderr.write('Authorization: Bearer synthetic-');
    setTimeout(()=>process.stderr.write('stderr-value\\n'+${JSON.stringify(token)}),10);
  });`;
  const result = await runCliAgent({ args: [process.execPath, '-e', source], cwd, stdinText: 'test',
    timeoutMs: 5000, transcriptPath, redactValues: [token], onEvent(event) {
      if (provider === 'claude') handleClaudeEvent(event, state as ReturnType<typeof createClaudeStreamState>, e => progress.push(e));
      else handleCodexEvent(event, state as ReturnType<typeof createCodexStreamState>, e => progress.push(e));
    } });
  expect(progress.length).toBeGreaterThan(0);
  const saved = await readFile(transcriptPath, 'utf8');
  for (const output of [JSON.stringify(progress), saved, result.stderr]) {
    expect(output).not.toContain('synthetic-');
    expect(output).toContain('<redacted-token>');
  }
  for (const line of saved.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
});

test('subprocess runner bounds an unresponsive provider with a timeout', async () => {
  const result = await runCliAgent({ args: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], stdinText: 'task',
    cwd: tempDir(), timeoutMs: 50, onEvent() {} });
  expect(result.timedOut).toBe(true);
  expect(result.detached).toBe(false);
});

test.skipIf(process.platform === 'win32')('Codex redacts its separate last-message file before returning it', async () => {
  const cwd = tempDir();
  const binary = join(cwd, 'provider');
  await writeFile(binary, `#!/usr/bin/env bun
    import { writeFileSync } from 'node:fs';
    process.stdin.resume(); process.stdin.on('end', () => {
      writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1],
        'Token synthetic-run-value; Authorization: Bearer synthetic-auth-value');
    });`);
  await chmod(binary, 0o755);
  const result = await new CodexProvider(binary).run({ cwd, systemPrompt: '', prompt: 'test', timeoutMs: 5000,
    runtime: { kind: 'qa', token: 'synthetic-run-value' } });
  expect(result.exitCode).toBe(0);
  expect(result.finalText).toBe('Token <redacted-token>; Authorization: <redacted-token>');
});

test('Claude adapter keeps final result, usage, and error state separate', () => {
  const state = createClaudeStreamState();
  handleClaudeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'intermediate' }] } }, state);
  handleClaudeEvent({ type: 'assistant', parent_tool_use_id: 'tool-1', message: { content: [{ type: 'text', text: 'nested' }] } }, state);
  expect(state.lastAssistantText).toBe('intermediate');
  handleClaudeEvent({ type: 'result', result: 'final', usage: { input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 5 } }, state);
  expect(state.finalText).toBe('final');
  expect(state.usage).toMatchObject({ inputTokens: 7, outputTokens: 5 });
  handleClaudeEvent({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'limit' }, state);
  expect(state.error).toBe('limit');
  const args = buildClaudeArgs(['claude'], { systemPrompt: 'map the app', model: 'example-model' });
  expect(args).toContain('--dangerously-skip-permissions');
  expect(args).toContain('example-model');
});

test('Codex adapter retains reconnect notices as progress and failures as errors', () => {
  const state = createCodexStreamState();
  handleCodexEvent({ type: 'error', message: 'Reconnecting 1/5' }, state);
  expect(state.error).toBeUndefined();
  handleCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }, state);
  expect(state.lastAgentMessage).toBe('final');
  handleCodexEvent({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 6 } }, state);
  expect(state.usage).toMatchObject({ inputTokens: 5, outputTokens: 6 });
  handleCodexEvent({ type: 'turn.failed', error: { message: 'authentication failed' } }, state);
  expect(state.error).toBe('authentication failed');
  const args = buildCodexArgs(['codex'], { cwd: '/tmp/app', reasoningEffort: 'high' }, '/tmp/last-message');
  expect(args.at(-1)).toBe('-');
  expect(args).toContain('--output-last-message');
  expect(args).toContain('model_reasoning_effort="high"');
});

test.skipIf(process.platform === 'win32')('timeout cleans descendants after a graceful provider root exit', async () => {
  const { writeFile } = await import('node:fs/promises');
  const cwd = tempDir('timeout-tree');
  const fixture = join(cwd, 'tree.mjs');
  await writeFile(fixture, `import {writeFileSync} from 'node:fs'; import {spawn} from 'node:child_process';
    const n=Number(process.argv[2]); writeFileSync(process.argv[3]+'/'+n+'.pid',String(process.pid));
    if(n<2)spawn(process.execPath,[process.argv[1],String(n+1),process.argv[3]],{stdio:'ignore'});
    process.on('SIGINT',()=>process.exit(0)); setInterval(()=>{},1000);`);
  const result = await runCliAgent({ args: [process.execPath, fixture, '0', cwd], cwd, stdinText: 'test', timeoutMs: 600, onEvent() {} });
  expect(result.timedOut).toBe(true); expect(result.detached).toBe(false);
  for (const depth of [1, 2]) {
    const pid = Number(await readFile(join(cwd, `${depth}.pid`), 'utf8'));
    const probe = Bun.spawn(['ps', '-p', String(pid), '-o', 'stat='], { stdout: 'pipe' });
    const state = (await new Response(probe.stdout).text()).trim(); await probe.exited;
    try { expect(state === '' || state.startsWith('Z')).toBe(true); }
    finally { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}, 10_000);


test.skipIf(process.platform === 'win32')('natural provider exit cleans inherited pipes without timing out or losing its final event', async () => {
  const { writeFile } = await import('node:fs/promises');
  const cwd = tempDir('natural-exit-tree');
  const fixture = join(cwd, 'tree.mjs');
  await writeFile(fixture, `import {writeFileSync, existsSync} from 'node:fs'; import {spawn} from 'node:child_process';
    const n=Number(process.argv[2]); writeFileSync(process.argv[3]+'/'+n+'.pid',String(process.pid));
    if(n<2)spawn(process.execPath,[process.argv[1],String(n+1),process.argv[3]],{stdio:'inherit'});
    setInterval(()=>{
      if(n===0 && existsSync(process.argv[3]+'/2.pid')) {
        console.log(JSON.stringify({type:'final',text:'All done.'})); process.exit(0);
      }
    },10);`);
  const events: unknown[] = [];
  const result = await runCliAgent({ args: [process.execPath, fixture, '0', cwd], cwd, stdinText: 'test', timeoutMs: 3000,
    onEvent: event => events.push(event) });
  expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false, detached: false });
  expect(events).toEqual([{ type: 'final', text: 'All done.' }]);
  for (const depth of [1, 2]) {
    const pid = Number(await readFile(join(cwd, `${depth}.pid`), 'utf8'));
    const probe = Bun.spawn(['ps', '-p', String(pid), '-o', 'stat='], { stdout: 'pipe' });
    const state = (await new Response(probe.stdout).text()).trim(); await probe.exited;
    try { expect(state === '' || state.startsWith('Z')).toBe(true); }
    finally { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}, 10000);
