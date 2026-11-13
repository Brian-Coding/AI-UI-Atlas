import { describe, expect, test } from 'bun:test';
import { booleanFlag, formatFlagHelp, numberFlag, parseArgs, stringFlag, type FlagSpecs } from './args';

const specs: FlagSpecs = {
  url: { type: 'string' },
  goal: { type: 'string', alias: 'g' },
  timeout: { type: 'number' },
  json: { type: 'boolean' },
  atlas: { type: 'boolean' },
  project: { type: 'string', alias: 'p' },
};

describe('parseArgs', () => {
  test('parses long flags, inline values, aliases, and positionals', () => {
    const parsed = parseArgs(['./app', '--url', 'http://x', '--goal=check it', '-p', 'dir', '--timeout', '5', '--json', 'extra'], specs);
    expect(parsed.errors).toEqual([]);
    expect(parsed.positionals).toEqual(['./app', 'extra']);
    expect(stringFlag(parsed.flags, 'url')).toBe('http://x');
    expect(stringFlag(parsed.flags, 'goal')).toBe('check it');
    expect(stringFlag(parsed.flags, 'project')).toBe('dir');
    expect(numberFlag(parsed.flags, 'timeout')).toBe(5);
    expect(booleanFlag(parsed.flags, 'json')).toBe(true);
  });

  test('supports --no-<flag> for booleans and explicit true/false', () => {
    expect(parseArgs(['--no-atlas'], specs).flags.atlas).toBe(false);
    expect(parseArgs(['--atlas=false'], specs).flags.atlas).toBe(false);
    expect(parseArgs(['--json=true'], specs).flags.json).toBe(true);
    expect(parseArgs(['--json=maybe'], specs).errors[0]).toContain('expects true or false');
    expect(booleanFlag({}, 'atlas', true)).toBe(true);
  });

  test('reports unknown options, missing values, and bad numbers', () => {
    expect(parseArgs(['--nope'], specs).errors).toEqual(['Unknown option: --nope']);
    expect(parseArgs(['-z'], specs).errors).toEqual(['Unknown option: -z']);
    expect(parseArgs(['--url'], specs).errors).toEqual(['--url requires a value']);
    expect(parseArgs(['--url', '--json'], specs).errors).toEqual(['--url requires a value']);
    expect(parseArgs(['--timeout', 'soon'], specs).errors[0]).toContain('expects a number');
    expect(parseArgs(['--no-url'], specs).errors).toEqual(['Unknown option: --no-url']);
  });

  test('accepts negative numbers and stops at --', () => {
    expect(parseArgs(['--timeout', '-1'], specs).flags.timeout).toBe(-1);
    const parsed = parseArgs(['--json', '--', '--url', 'x'], specs);
    expect(parsed.positionals).toEqual(['--url', 'x']);
    expect(parsed.flags.url).toBeUndefined();
  });

  test('formats help with aliases and value hints', () => {
    const help = formatFlagHelp({ goal: { type: 'string', alias: 'g', description: 'What to verify' }, json: { type: 'boolean' } });
    expect(help).toContain('-g, --goal <value>');
    expect(help).toContain('What to verify');
    expect(help).toContain('--json');
  });
});
