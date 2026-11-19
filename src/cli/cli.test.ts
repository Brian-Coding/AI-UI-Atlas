import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { cleanupTempDirs, collectIo, projectWithAtlas, tempDir } from '../../tests/helpers';
import { FakeBrowserDriver } from '../browser/fake-driver';
import { runCli } from './cli';

afterEach(cleanupTempDirs);

test.each(['atlas', 'qa'])('%s group help lists only its subcommands without requiring a provider', async group => {
  for (const flag of ['--help', '-h']) {
    const capture = collectIo(tempDir());
    expect(await runCli([group, flag], capture.io)).toBe(0);
    expect(capture.stderr()).toBe('');
    expect(capture.stdout()).toContain(`Usage: bun run ${group} <subcommand>`);
    expect(capture.stdout()).toContain(group === 'atlas' ? 'atlas build' : 'qa run');
    expect(capture.stdout()).not.toContain(group === 'atlas' ? 'qa run' : 'atlas build');
  }
});

test('unknown group subcommands still fail', async () => {
  const capture = collectIo(tempDir());
  expect(await runCli(['atlas', 'not-a-command'], capture.io)).toBe(1);
  expect(capture.stderr()).toContain('Unknown atlas subcommand');
});

test('CLI help, error handling, and offline JSON commands need no provider', async () => {
  const project = await projectWithAtlas();
  const capture = collectIo(project);
  expect(await runCli(['--help'], capture.io)).toBe(0);
  expect(capture.stdout()).toContain('atlas build');
  expect(await runCli(['atlas', 'validate'], capture.io)).toBe(0);
  capture.out.length = 0;
  expect(await runCli(['atlas', 'query', 'tags', '--json'], capture.io)).toBe(0);
  expect(JSON.parse(capture.stdout()).intent).toBe('entity-surfaces');
  expect(await runCli(['atlas', 'query', 'nonexistent-zzzz'], capture.io)).toBe(1);
  expect(await runCli(['qa', 'run', '--unknown'], capture.io)).toBe(1);
  expect(await runCli(['qa', 'run', '--url', 'http://app.test/'], capture.io)).toBe(1);
});

test('CLI persists and reruns an inconclusive scripted result with exit code 2', async () => {
  const project = tempDir();
  const module = join(project, 'agent.ts');
  await Bun.write(module, 'export default () => "No structured result";');
  const capture = collectIo(project);
  const io = { ...capture.io, driver: new FakeBrowserDriver() };
  expect(await runCli(['qa', 'run', '--url', 'http://app.test/', '--goal', 'Check notes', '--provider', `script:${module}`, '--json'], io)).toBe(2);
  const run = JSON.parse(capture.stdout());
  expect(run.verdict).toBe('inconclusive');
  capture.out.length = 0;
  expect(await runCli(['qa', 'rerun', run.id, '--provider', `script:${module}`, '--json'], io)).toBe(2);
  expect(JSON.parse(capture.stdout()).rerunOf).toBe(run.id);
});
