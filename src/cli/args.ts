/** Tiny, dependency-free argument parser with strict validation. */

export type FlagType = 'string' | 'boolean' | 'number';

export interface FlagSpec {
  type: FlagType;
  alias?: string;
  description?: string;
}

export type FlagSpecs = Record<string, FlagSpec>;

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | number>;
  errors: string[];
}

/**
 * Parse argv against a flag spec. Supports `--name value`, `--name=value`,
 * `-a value`, boolean `--name` / `--no-name`, and `--` to end flag parsing.
 * Unknown flags and missing or malformed values are reported, not ignored.
 */
export function parseArgs(argv: string[], specs: FlagSpecs): ParsedArgs {
  const positionals: string[] = [];
  const flags: ParsedArgs['flags'] = {};
  const errors: string[] = [];
  const aliases = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) if (spec.alias) aliases.set(spec.alias, name);

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }

    let name: string;
    let inline: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    } else {
      const alias = arg.slice(1);
      const resolved = aliases.get(alias);
      if (!resolved) {
        errors.push(`Unknown option: ${arg}`);
        continue;
      }
      name = resolved;
    }

    let spec = specs[name];
    if (!spec && name.startsWith('no-') && specs[name.slice(3)]?.type === 'boolean') {
      if (inline !== undefined) errors.push(`--${name} does not take a value`);
      flags[name.slice(3)] = false;
      continue;
    }
    if (!spec) {
      errors.push(`Unknown option: --${name}`);
      continue;
    }

    if (spec.type === 'boolean') {
      if (inline === undefined) flags[name] = true;
      else if (inline === 'true' || inline === 'false') flags[name] = inline === 'true';
      else errors.push(`--${name} expects true or false`);
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-' && !/^-\d/.test(next))) {
        errors.push(`--${name} requires a value`);
        continue;
      }
      value = next;
      index++;
    }
    if (spec.type === 'number') {
      const parsed = Number(value);
      if (value.trim() === '' || !Number.isFinite(parsed)) errors.push(`--${name} expects a number, got "${value}"`);
      else flags[name] = parsed;
    } else {
      flags[name] = value;
    }
  }
  return { positionals, flags, errors };
}

export function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function numberFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = flags[name];
  return typeof value === 'number' ? value : undefined;
}

export function booleanFlag(flags: ParsedArgs['flags'], name: string, fallback = false): boolean {
  const value = flags[name];
  return typeof value === 'boolean' ? value : fallback;
}

export function formatFlagHelp(specs: FlagSpecs): string {
  return Object.entries(specs)
    .map(([name, spec]) => {
      const label = `${spec.alias ? `-${spec.alias}, ` : '    '}--${name}${spec.type === 'boolean' ? '' : ` <${spec.type === 'number' ? 'n' : 'value'}>`}`;
      return `  ${label.padEnd(30)} ${spec.description ?? ''}`.trimEnd();
    })
    .join('\n');
}
