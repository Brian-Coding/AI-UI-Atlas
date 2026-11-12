#!/usr/bin/env bun
import { runCli } from './cli';

const controller = new AbortController();
let interrupts = 0;
// First Ctrl+C asks the running agent to stop and still writes a report;
// a second one exits immediately.
process.on('SIGINT', () => {
  interrupts++;
  if (interrupts > 1) process.exit(130);
  process.stderr.write('\nStopping (Ctrl+C again to force quit)...\n');
  controller.abort(new Error('interrupted'));
});

const code = await runCli(process.argv.slice(2), {
  out: text => process.stdout.write(`${text}\n`),
  err: text => process.stderr.write(`${text}\n`),
  cwd: process.cwd(),
  signal: controller.signal,
});
process.exit(code);
