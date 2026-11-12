import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { askAtlas } from '../atlas/atlas-ask';
import { validatePublishedAtlas } from '../atlas/atlas-artifacts';
import { buildAtlas, discardAtlasRun, readAtlasRunState, resumeAtlas, type AtlasRunState } from '../atlas/atlas-runner';
import { describeSurface, formatQueryResult, formatSurfaceDetail, loadPublishedAtlas, queryAtlas } from '../atlas/atlas-search';
import type { BrowserDriver } from '../browser/driver';
import { projectPaths } from '../core/paths';
import { resolveProvider } from '../providers/registry';
import type { AgentProgressEvent } from '../providers/types';
import { exitCodeForRun, runQa } from '../qa/qa-runner';
import { VERDICT_LABELS } from '../qa/report';
import { RunStore } from '../qa/run-store';
import type { QaRunRecord } from '../qa/types';
import { booleanFlag, formatFlagHelp, numberFlag, parseArgs, stringFlag, type FlagSpecs } from './args';
import { runDoctor } from './doctor';
import { runServe } from './serve';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  cwd: string;
  /** Test seam: inject a browser driver instead of spawning Playwright. */
  driver?: BrowserDriver;
  signal?: AbortSignal;
}

const PROVIDER_FLAGS: FlagSpecs = {
  provider: { type: 'string', description: 'claude (default), codex, or script:<path>' },
  model: { type: 'string', description: 'Model passed to the provider CLI' },
  reasoning: { type: 'string', description: 'Codex reasoning effort (low|medium|high|xhigh)' },
  timeout: { type: 'number', description: 'Hard time limit in minutes' },
  headed: { type: 'boolean', description: 'Show the browser window' },
  quiet: { type: 'boolean', alias: 'q', description: 'Only print the final result' },
};

const COMMON_FLAGS: FlagSpecs = {
  project: { type: 'string', alias: 'p', description: 'Project directory (default: current directory)' },
  json: { type: 'boolean', description: 'Print machine-readable JSON' },
  help: { type: 'boolean', alias: 'h', description: 'Show help' },
};

const COMMANDS: Record<string, { usage: string; summary: string; flags: FlagSpecs }> = {
  'atlas build': {
    usage: 'atlas build [projectDir] --url <appUrl> [--focus "..."]',
    summary: 'Map the app into docs/ui-atlas (updates an existing atlas).',
    flags: { ...COMMON_FLAGS, ...PROVIDER_FLAGS, url: { type: 'string', description: 'URL of the running app (required)' }, focus: { type: 'string', description: 'Area to cover most thoroughly' } },
  },
  'atlas resume': {
    usage: 'atlas resume [projectDir] [--url <appUrl>]',
    summary: 'Continue a paused or failed atlas build from its checkpoint.',
    flags: { ...COMMON_FLAGS, ...PROVIDER_FLAGS, url: { type: 'string', description: 'Override the app URL' } },
  },
  'atlas status': { usage: 'atlas status [projectDir]', summary: 'Show the published atlas and the latest build.', flags: COMMON_FLAGS },
  'atlas discard': { usage: 'atlas discard [projectDir]', summary: 'Delete a paused/failed candidate (published atlas untouched).', flags: COMMON_FLAGS },
  'atlas validate': { usage: 'atlas validate [projectDir]', summary: 'Check the published atlas against the schema.', flags: COMMON_FLAGS },
  'atlas query': {
    usage: 'atlas query "<question>" [-p projectDir]',
    summary: 'Answer from the atlas graph offline (no LLM).',
    flags: COMMON_FLAGS,
  },
  'atlas show': { usage: 'atlas show <surface.id|entity.id|flow.id>', summary: 'Print one atlas record.', flags: COMMON_FLAGS },
  'atlas ask': {
    usage: 'atlas ask "<question>" [-p projectDir]',
    summary: 'Ask an LLM analyst; answers must cite real atlas IDs.',
    flags: { ...COMMON_FLAGS, ...PROVIDER_FLAGS },
  },
  'qa run': {
    usage: 'qa run --url <appUrl> --goal "<what to test>" [--change "<what changed>"]',
    summary: 'Run one evidence-backed browser QA pass.',
    flags: {
      ...COMMON_FLAGS,
      ...PROVIDER_FLAGS,
      url: { type: 'string', description: 'URL to test (required)' },
      goal: { type: 'string', alias: 'g', description: 'What to verify (required)' },
      change: { type: 'string', description: 'Description of the change under test' },
      atlas: { type: 'boolean', description: 'Use docs/ui-atlas when present (default true; --no-atlas)' },
      'fail-on-warnings': { type: 'boolean', description: 'Exit 1 on WARNINGS' },
      'keep-runs': { type: 'number', description: 'Run history to retain (default 50)' },
    },
  },
  'qa rerun': {
    usage: 'qa rerun <runId>',
    summary: 'Repeat a previous run with the same URL and goal.',
    flags: { ...COMMON_FLAGS, ...PROVIDER_FLAGS, 'fail-on-warnings': { type: 'boolean', description: 'Exit 1 on WARNINGS' } },
  },
  'qa list': { usage: 'qa list [-p projectDir]', summary: 'List QA runs, newest first.', flags: COMMON_FLAGS },
  'qa show': { usage: 'qa show <runId> [-p projectDir]', summary: 'Print a run\'s report.', flags: COMMON_FLAGS },
  serve: {
    usage: 'serve [projectDir] [--port 4477] [--allow-ask]',
    summary: 'Open the local viewer for the atlas and QA runs.',
    flags: {
      ...COMMON_FLAGS,
      port: { type: 'number', description: 'Port (default 4477; 0 = any free port)' },
      'allow-ask': { type: 'boolean', description: 'Enable LLM "Ask" in the viewer' },
      provider: PROVIDER_FLAGS.provider!,
      model: PROVIDER_FLAGS.model!,
    },
  },
  doctor: { usage: 'doctor', summary: 'Check Bun, Node, Chromium, and provider CLIs.', flags: { help: COMMON_FLAGS.help! } },
};

export function usage(): string {
  const width = Math.max(...Object.values(COMMANDS).map(c => c.usage.length));
  return [
    'atlas-qa: UI Atlas + browser QA driven by Claude Code or Codex',
    '',
    'Usage: bun run cli <command> [options]   (or: bun run atlas ..., bun run qa ...)',
    '',
    'Commands:',
    ...Object.values(COMMANDS).map(c => `  ${c.usage.padEnd(width)}  ${c.summary}`),
    '',
    'Run any command with --help for its options. Docs: docs/getting-started.md',
  ].join('\n');
}

function commandHelp(name: string): string {
  const command = COMMANDS[name]!;
  return [`Usage: ${command.usage}`, '', command.summary, '', 'Options:', formatFlagHelp(command.flags)].join('\n');
}

function progressPrinter(io: CliIo, label: string, quiet: boolean) {
  return (event: AgentProgressEvent) => {
    if (quiet) return;
    const oneLine = (text: string) => {
      const flat = text.replace(/\s+/g, ' ').trim();
      return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
    };
    if (event.type === 'tool') io.err(`[${label}] ${event.name}${event.summary ? `: ${oneLine(event.summary)}` : ''}`);
    else if (event.type === 'text') io.err(`[${label}] ${oneLine(event.text)}`);
    else io.err(`[${label}] ${oneLine(event.message)}`);
  };
}

function printRunResult(io: CliIo, run: QaRunRecord, reportPath: string, json: boolean): void {
  if (json) {
    io.out(JSON.stringify({ ...run, reportPath }, null, 2));
    return;
  }
  const verdict = run.verdict ? VERDICT_LABELS[run.verdict] : run.status.toUpperCase();
  io.out(`${verdict}: ${run.summary ?? ''}`);
  for (const finding of run.findings ?? []) io.out(`  - [${finding.severity}] ${finding.title}`);
  for (const error of run.validationErrors ?? []) io.out(`  ! ${error}`);
  io.out(`Report: ${reportPath}`);
}

function printAtlasState(io: CliIo, state: AtlasRunState, json: boolean): void {
  if (json) {
    io.out(JSON.stringify(state, null, 2));
    return;
  }
  io.out(`Atlas run ${state.id}: ${state.status} (${state.phase})`);
  if (state.surfaceCount !== undefined) {
    io.out(`  ${state.surfaceCount} surfaces (${state.verifiedSurfaceCount ?? 0} verified), ${state.entityCount ?? 0} entities`);
  }
  if (state.error) io.out(`  ${state.error}`);
  for (const error of (state.validationErrors ?? []).slice(0, 15)) io.out(`  - ${error}`);
  if ((state.validationErrors?.length ?? 0) > 15) io.out(`  ... and ${(state.validationErrors!.length - 15)} more`);
}

function timeoutMs(flags: Record<string, unknown>): number | undefined {
  const minutes = numberFlag(flags as any, 'timeout');
  if (minutes === undefined) return undefined;
  if (minutes <= 0) throw new Error('--timeout must be a positive number of minutes');
  return Math.round(minutes * 60_000);
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [first, second] = argv;
  if (!first || first === '--help' || first === '-h' || first === 'help') {
    io.out(usage());
    return first ? 0 : 1;
  }
  if (first === '--version' || first === 'version') {
    io.out('atlas-qa 0.1.0');
    return 0;
  }
  const twoWord = `${first} ${second ?? ''}`;
  const name = COMMANDS[twoWord] ? twoWord : COMMANDS[first] ? first : null;
  if (!name) {
    io.err(first === 'atlas' || first === 'qa'
      ? `Unknown ${first} subcommand: ${second ?? '(none)'}\n\n${usage()}`
      : `Unknown command: ${first}\n\n${usage()}`);
    return 1;
  }
  const rest = argv.slice(name.split(' ').length);
  const command = COMMANDS[name]!;
  const { positionals, flags, errors } = parseArgs(rest, command.flags);
  if (booleanFlag(flags, 'help')) {
    io.out(commandHelp(name));
    return 0;
  }
  if (errors.length) {
    io.err(`${errors.join('\n')}\n\n${commandHelp(name)}`);
    return 1;
  }

  const json = booleanFlag(flags, 'json');
  const quiet = booleanFlag(flags, 'quiet') || json;
  const projectFromFlag = stringFlag(flags, 'project');
  const projectArg = (positionalIsProject: boolean) =>
    resolve(io.cwd, (positionalIsProject ? positionals[0] : undefined) ?? projectFromFlag ?? '.');

  try {
    switch (name) {
      case 'atlas build':
      case 'atlas resume': {
        const projectDir = projectArg(true);
        const url = stringFlag(flags, 'url');
        if (name === 'atlas build' && !url) throw new Error('--url is required (the running app to map)');
        const provider = await resolveProvider(stringFlag(flags, 'provider'));
        const common = {
          projectDir,
          provider,
          model: stringFlag(flags, 'model'),
          reasoningEffort: stringFlag(flags, 'reasoning'),
          timeoutMs: timeoutMs(flags),
          headed: booleanFlag(flags, 'headed'),
          driver: io.driver,
          signal: io.signal,
          onProgress: progressPrinter(io, 'atlas', quiet),
          onPhase: (phase: string) => { if (!quiet) io.err(`[atlas] phase: ${phase}`); },
        };
        if (!quiet) io.err(`[atlas] ${name === 'atlas build' ? 'building' : 'resuming'} atlas for ${projectDir} with ${provider.name}`);
        const state = name === 'atlas build'
          ? await buildAtlas({ ...common, url: url!, focus: stringFlag(flags, 'focus') })
          : await resumeAtlas({ ...common, url });
        printAtlasState(io, state, json);
        if (state.status === 'completed' && !json) io.out(`Published: ${projectPaths(projectDir).atlasRoot}`);
        return state.status === 'completed' ? 0 : 1;
      }
      case 'atlas status': {
        const projectDir = projectArg(true);
        const validation = await validatePublishedAtlas(projectDir);
        const state = await readAtlasRunState(projectDir);
        if (json) {
          io.out(JSON.stringify({ published: validation, latestRun: state }, null, 2));
          return 0;
        }
        if (validation.surfaceCount > 0 || validation.valid) {
          io.out(`Published atlas: ${projectPaths(projectDir).atlasRoot}`);
          io.out(`  ${validation.surfaceCount} surfaces (${validation.verifiedSurfaceCount} verified), ${validation.entityCount} entities, ${validation.valid ? 'valid' : 'INVALID'}`);
        } else {
          io.out('No published atlas.');
        }
        if (state) printAtlasState(io, state, false);
        return 0;
      }
      case 'atlas discard': {
        const state = await discardAtlasRun(projectArg(true));
        io.out(`Discarded atlas candidate ${state.id}. The published atlas is unchanged.`);
        return 0;
      }
      case 'atlas validate': {
        const result = await validatePublishedAtlas(projectArg(true));
        if (json) io.out(JSON.stringify(result, null, 2));
        else if (result.valid) io.out(`Valid: ${result.surfaceCount} surfaces, ${result.entityCount} entities.`);
        else io.out(`Invalid atlas:\n${result.errors.map(error => `  - ${error}`).join('\n')}`);
        return result.valid ? 0 : 1;
      }
      case 'atlas query': {
        const question = positionals.join(' ').trim();
        if (!question) throw new Error('Ask a question, e.g. atlas query "where is the note title shown?"');
        const { root, graph } = await loadPublishedAtlas(projectArg(false));
        const result = queryAtlas(graph, question);
        io.out(json ? JSON.stringify(result, null, 2) : formatQueryResult(graph, result, root));
        return result.intent === 'search' ? 1 : 0;
      }
      case 'atlas show': {
        const id = positionals[0];
        if (!id) throw new Error('Pass an atlas ID, e.g. atlas show surface.home');
        const { root, graph } = await loadPublishedAtlas(projectArg(false));
        const record = [...graph.surfaces, ...graph.entities, ...(graph.flows ?? [])].find(item => item.id === id);
        if (!record) throw new Error(`No atlas record with ID ${id}`);
        if (json) io.out(JSON.stringify(record, null, 2));
        else if (id.startsWith('surface.')) io.out(formatSurfaceDetail(graph, describeSurface(graph, id)!, root));
        else io.out(formatQueryResult(graph, queryAtlas(graph, id), root));
        return 0;
      }
      case 'atlas ask': {
        const question = positionals.join(' ').trim();
        if (!question) throw new Error('Ask a question, e.g. atlas ask "which screens let me delete a note?"');
        const provider = await resolveProvider(stringFlag(flags, 'provider'));
        if (!quiet) io.err(`[ask] asking ${provider.name}...`);
        const answer = await askAtlas({
          projectDir: projectArg(false),
          question,
          provider,
          model: stringFlag(flags, 'model'),
          reasoningEffort: stringFlag(flags, 'reasoning'),
          timeoutMs: timeoutMs(flags),
          signal: io.signal,
        });
        io.out(json ? JSON.stringify(answer, null, 2) : `${answer.answer}\n\nCitations: ${answer.citations.join(', ')}`);
        return 0;
      }
      case 'qa run':
      case 'qa rerun': {
        const projectDir = projectArg(false);
        let url = stringFlag(flags, 'url');
        let goal = stringFlag(flags, 'goal') ?? (name === 'qa run' ? positionals.join(' ').trim() || undefined : undefined);
        let change = stringFlag(flags, 'change');
        let rerunOf: string | undefined;
        if (name === 'qa rerun') {
          rerunOf = positionals[0];
          if (!rerunOf) throw new Error('Pass the run ID to repeat');
          const prior = await new RunStore(projectPaths(projectDir).runsDir).get(rerunOf);
          if (!prior) throw new Error(`Run ${rerunOf} not found in ${projectPaths(projectDir).runsDir}`);
          url = prior.url;
          goal = prior.goal;
          change = prior.changeDescription;
        }
        if (!url) throw new Error('--url is required (the page to test)');
        if (!goal) throw new Error('--goal is required (what should be verified?)');
        const provider = await resolveProvider(stringFlag(flags, 'provider'));
        const outcome = await runQa({
          projectDir,
          url,
          goal,
          changeDescription: change,
          provider,
          model: stringFlag(flags, 'model'),
          reasoningEffort: stringFlag(flags, 'reasoning'),
          timeoutMs: timeoutMs(flags),
          useAtlas: booleanFlag(flags, 'atlas', true),
          keepRuns: numberFlag(flags, 'keep-runs'),
          rerunOf,
          headed: booleanFlag(flags, 'headed'),
          driver: io.driver,
          signal: io.signal,
          onProgress: progressPrinter(io, 'qa', quiet),
          onStart: (run, runDir) => {
            if (!quiet) io.err(`[qa] run ${run.id} with ${provider.name}${run.atlasUsed ? ' (using UI Atlas)' : ''} -> ${runDir}`);
          },
        });
        printRunResult(io, outcome.run, outcome.reportPath, json);
        return exitCodeForRun(outcome.run, booleanFlag(flags, 'fail-on-warnings'));
      }
      case 'qa list': {
        const store = new RunStore(projectPaths(projectArg(false)).runsDir);
        const runs = await store.list();
        if (json) io.out(JSON.stringify(runs, null, 2));
        else if (runs.length === 0) io.out('No QA runs yet.');
        else for (const run of runs) {
          const verdict = run.verdict ? VERDICT_LABELS[run.verdict] : run.status.toUpperCase();
          io.out(`${run.id}  ${verdict.padEnd(12)}  ${run.createdAt}  ${run.goal.replace(/\s+/g, ' ').slice(0, 70)}`);
        }
        return 0;
      }
      case 'qa show': {
        const id = positionals[0];
        if (!id) throw new Error('Pass a run ID (see qa list)');
        const store = new RunStore(projectPaths(projectArg(false)).runsDir);
        const run = await store.get(id);
        if (!run) throw new Error(`Run ${id} not found`);
        io.out(json ? JSON.stringify(run, null, 2) : (await store.readFile(id, 'report.md')) ?? JSON.stringify(run, null, 2));
        return 0;
      }
      case 'serve': {
        const projectDir = projectArg(true);
        if (!existsSync(projectDir)) throw new Error(`Project directory does not exist: ${projectDir}`);
        return runServe({
          projectDir,
          port: numberFlag(flags, 'port') ?? 4477,
          allowAsk: booleanFlag(flags, 'allow-ask'),
          provider: stringFlag(flags, 'provider'),
          model: stringFlag(flags, 'model'),
          io,
        });
      }
      case 'doctor':
        return runDoctor(io);
    }
    return 1;
  } catch (error) {
    io.err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
