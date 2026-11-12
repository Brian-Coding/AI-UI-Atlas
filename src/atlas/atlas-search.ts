// Deterministic, offline queries over a published atlas.json. No LLM involved:
// answers "where is X shown?", "what screens touch entity Y?", "how do I get
// to Z?" by ranking graph records and walking flows.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectPaths } from '../core/paths';
import type { AtlasEntityRecord, AtlasFlowRecord, AtlasGraph, AtlasSurfaceRecord } from './atlas-artifacts';

export type AtlasItemKind = 'surface' | 'entity' | 'flow';

export interface AtlasMatch {
  id: string;
  kind: AtlasItemKind;
  name: string;
  score: number;
}

export interface SurfaceDetail {
  surface: AtlasSurfaceRecord;
  entities: AtlasEntityRecord[];
  inbound: AtlasFlowRecord[];
  outbound: AtlasFlowRecord[];
  /** Shortest flow chain from an entry surface, empty if it is an entry. */
  clickPath: AtlasFlowRecord[] | null;
}

export type AtlasQueryResult =
  | { intent: 'entity-surfaces'; entity: AtlasEntityRecord; surfaces: AtlasSurfaceRecord[]; matches: AtlasMatch[] }
  | { intent: 'surface'; detail: SurfaceDetail; matches: AtlasMatch[] }
  | { intent: 'flow'; flow: AtlasFlowRecord; matches: AtlasMatch[] }
  | { intent: 'search'; matches: AtlasMatch[] };

export interface LoadedAtlas {
  root: string;
  graph: AtlasGraph;
}

export async function loadPublishedAtlas(projectDir: string): Promise<LoadedAtlas> {
  const root = projectPaths(projectDir).atlasRoot;
  const graphPath = join(root, 'atlas.json');
  if (!existsSync(graphPath)) {
    throw new Error(`No published UI Atlas at ${root}. Build one with: atlas build <projectDir> --url <appUrl>`);
  }
  const graph = JSON.parse(await readFile(graphPath, 'utf8')) as AtlasGraph;
  graph.surfaces = Array.isArray(graph.surfaces) ? graph.surfaces : [];
  graph.entities = Array.isArray(graph.entities) ? graph.entities : [];
  graph.flows = Array.isArray(graph.flows) ? graph.flows : [];
  return { root, graph };
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'be', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'with',
  'where', 'what', 'which', 'who', 'how', 'do', 'does', 'i', 'can', 'we', 'it', 'its', 'this', 'that',
  'shown', 'show', 'shows', 'displayed', 'display', 'appear', 'appears', 'visible', 'see', 'find',
  'screen', 'screens', 'surface', 'surfaces', 'page', 'pages', 'view', 'views', 'ui', 'app',
  'touch', 'touches', 'use', 'uses', 'get', 'go', 'reach', 'open', 'from', 'me', 'my', 'any', 'all',
  'entity', 'entities', 'data', 'there', 'about', 'tell',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 1 && !STOPWORDS.has(token))
    .map(token => (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token));
}

function textTokens(values: Array<string | undefined | string[]>): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string') for (const token of tokenize(item)) out.add(token);
    }
  }
  return out;
}

function score(queryTokens: string[], primary: Set<string>, secondary: Set<string>): number {
  let total = 0;
  for (const token of queryTokens) {
    if (primary.has(token)) total += 3;
    else if ([...primary].some(candidate => candidate.startsWith(token) || token.startsWith(candidate))) total += 2;
    else if (secondary.has(token)) total += 1;
  }
  return total;
}

function idSlugTokens(id: string): string[] {
  return id.replace(/^(surface|entity|flow)\./, '').split('-');
}

export function rankAtlas(graph: AtlasGraph, question: string, limit = 10): AtlasMatch[] {
  const mentionedIds = new Set(question.match(/\b(?:surface|entity|flow)\.[a-z0-9][a-z0-9-]*/gi)?.map(id => id.toLowerCase()) ?? []);
  const queryTokens = tokenize(question);
  // "How do I get to X?" is about navigation, so surfaces win close calls.
  const navigation = /\b(how|get to|reach|navigate|go to|open|path to|click)\b/i.test(question);
  const matches: AtlasMatch[] = [];
  const consider = (kind: AtlasItemKind, id: string, name: string, primary: Set<string>, secondary: Set<string>) => {
    let value = mentionedIds.has(id) ? 100 : score(queryTokens, primary, secondary);
    if (value > 0 && navigation && kind === 'surface') value += 2;
    if (value > 0) matches.push({ id, kind, name, score: value });
  };
  for (const entity of graph.entities) {
    consider('entity', entity.id, entity.name,
      textTokens([entity.name, idSlugTokens(entity.id)]),
      textTokens([entity.fields, entity.description, entity.codeRefs]));
  }
  for (const surface of graph.surfaces) {
    consider('surface', surface.id, surface.name,
      textTokens([surface.name, idSlugTokens(surface.id), surface.route]),
      textTokens([surface.description, surface.actions, surface.states, surface.reach, surface.codeRefs]));
  }
  for (const flow of graph.flows ?? []) {
    consider('flow', flow.id, flow.name, textTokens([flow.name, idSlugTokens(flow.id)]), textTokens([flow.trigger]));
  }
  const kindOrder: Record<AtlasItemKind, number> = { entity: 0, surface: 1, flow: 2 };
  return matches
    .sort((a, b) => b.score - a.score || kindOrder[a.kind] - kindOrder[b.kind] || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function surfacesForEntity(graph: AtlasGraph, entityId: string): AtlasSurfaceRecord[] {
  return graph.surfaces.filter(surface => (surface.entityIds ?? []).includes(entityId));
}

/** Shortest chain of flows from an entry surface (no inbound flows, or route "/"). */
export function clickPath(graph: AtlasGraph, surfaceId: string): AtlasFlowRecord[] | null {
  const flows = graph.flows ?? [];
  const inbound = new Set(flows.map(flow => flow.toSurfaceId));
  const entries = graph.surfaces
    .filter(surface => surface.route === '/' || !inbound.has(surface.id))
    .map(surface => surface.id);
  if (entries.includes(surfaceId)) return [];
  const queue: Array<{ id: string; path: AtlasFlowRecord[] }> = entries.map(id => ({ id, path: [] }));
  const seen = new Set(entries);
  while (queue.length) {
    const { id, path } = queue.shift()!;
    for (const flow of flows) {
      if (flow.fromSurfaceId !== id || seen.has(flow.toSurfaceId)) continue;
      const next = [...path, flow];
      if (flow.toSurfaceId === surfaceId) return next;
      seen.add(flow.toSurfaceId);
      queue.push({ id: flow.toSurfaceId, path: next });
    }
  }
  return null;
}

export function describeSurface(graph: AtlasGraph, surfaceId: string): SurfaceDetail | null {
  const surface = graph.surfaces.find(item => item.id === surfaceId);
  if (!surface) return null;
  const flows = graph.flows ?? [];
  return {
    surface,
    entities: graph.entities.filter(entity => (surface.entityIds ?? []).includes(entity.id)),
    inbound: flows.filter(flow => flow.toSurfaceId === surfaceId),
    outbound: flows.filter(flow => flow.fromSurfaceId === surfaceId),
    clickPath: clickPath(graph, surfaceId),
  };
}

/** Answer a natural-language question from the graph alone. */
export function queryAtlas(graph: AtlasGraph, question: string): AtlasQueryResult {
  const matches = rankAtlas(graph, question);
  const top = matches[0];
  if (!top) return { intent: 'search', matches };
  if (top.kind === 'entity') {
    const entity = graph.entities.find(item => item.id === top.id)!;
    return { intent: 'entity-surfaces', entity, surfaces: surfacesForEntity(graph, entity.id), matches };
  }
  if (top.kind === 'surface') {
    return { intent: 'surface', detail: describeSurface(graph, top.id)!, matches };
  }
  const flow = (graph.flows ?? []).find(item => item.id === top.id)!;
  return { intent: 'flow', flow, matches };
}

function surfaceName(graph: AtlasGraph, id: string): string {
  return graph.surfaces.find(surface => surface.id === id)?.name ?? id;
}

export function formatClickPath(graph: AtlasGraph, path: AtlasFlowRecord[] | null, surface: AtlasSurfaceRecord): string {
  if (path === null) return surface.reach ? surface.reach : '(no known flow reaches this surface)';
  if (path.length === 0) return `${surface.name} is an entry point${surface.route ? ` (${surface.route})` : ''}`;
  const steps = [surfaceName(graph, path[0]!.fromSurfaceId)];
  for (const flow of path) steps.push(`[${flow.trigger ?? flow.name}] ${surfaceName(graph, flow.toSurfaceId)}`);
  return steps.join(' -> ');
}

function surfaceLine(surface: AtlasSurfaceRecord): string {
  const bits = [`${surface.id}  ${surface.name}  (${surface.status})`];
  if (surface.route) bits.push(`route ${surface.route}`);
  return bits.join('  ');
}

export function formatSurfaceDetail(graph: AtlasGraph, detail: SurfaceDetail, atlasRoot?: string): string {
  const { surface } = detail;
  const lines = [`${surface.name}  [${surface.id}]  status: ${surface.status}`];
  if (surface.description) lines.push(`  ${surface.description}`);
  if (surface.route) lines.push(`  Route: ${surface.route}`);
  lines.push(`  How to reach: ${formatClickPath(graph, detail.clickPath, surface)}`);
  if (detail.entities.length) lines.push(`  Shows: ${detail.entities.map(entity => `${entity.name} (${entity.id})`).join(', ')}`);
  if (surface.actions?.length) lines.push(`  Actions: ${surface.actions.join('; ')}`);
  if (surface.states?.length) lines.push(`  States: ${surface.states.join('; ')}`);
  if (surface.codeRefs?.length) lines.push(`  Code: ${surface.codeRefs.join(', ')}`);
  if (detail.outbound.length) lines.push(`  Leads to: ${detail.outbound.map(flow => `${surfaceName(graph, flow.toSurfaceId)} via ${flow.trigger ?? flow.name}`).join('; ')}`);
  if (detail.inbound.length) lines.push(`  Reached from: ${detail.inbound.map(flow => surfaceName(graph, flow.fromSurfaceId)).join(', ')}`);
  for (const ref of surface.screenshotRefs ?? []) lines.push(`  Screenshot: ${atlasRoot ? join(atlasRoot, ref) : ref}`);
  return lines.join('\n');
}

export function formatQueryResult(graph: AtlasGraph, result: AtlasQueryResult, atlasRoot?: string): string {
  const lines: string[] = [];
  if (result.intent === 'search') {
    return 'No atlas surface, entity, or flow matched that question. Try different words, or `atlas ask` for an LLM answer.';
  }
  if (result.intent === 'entity-surfaces') {
    const { entity, surfaces } = result;
    lines.push(`${entity.name} [${entity.id}]${entity.description ? `: ${entity.description}` : ''}`);
    if (entity.fields?.length) lines.push(`  Fields: ${entity.fields.join(', ')}`);
    if (entity.codeRefs?.length) lines.push(`  Code: ${entity.codeRefs.join(', ')}`);
    lines.push('');
    if (surfaces.length === 0) lines.push('No surface in the atlas lists this entity.');
    else {
      lines.push(`Shown on ${surfaces.length} surface${surfaces.length === 1 ? '' : 's'}:`);
      for (const surface of surfaces) {
        lines.push(`  - ${surfaceLine(surface)}`);
        lines.push(`      reach: ${formatClickPath(graph, clickPath(graph, surface.id), surface)}`);
      }
    }
  } else if (result.intent === 'surface') {
    lines.push(formatSurfaceDetail(graph, result.detail, atlasRoot));
  } else {
    const { flow } = result;
    lines.push(`${flow.name} [${flow.id}]: ${surfaceName(graph, flow.fromSurfaceId)} -> ${surfaceName(graph, flow.toSurfaceId)}${flow.trigger ? ` via ${flow.trigger}` : ''}`);
  }
  const others = result.matches.slice(1, 6);
  if (others.length) {
    lines.push('', 'Also related:');
    for (const match of others) lines.push(`  - ${match.id}  ${match.name}`);
  }
  return lines.join('\n');
}
