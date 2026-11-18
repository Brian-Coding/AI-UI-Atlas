import { ClaudeProvider } from './claude';
import { CodexProvider } from './codex';
import { loadScriptedProvider } from './scripted';
import type { AgentProvider } from './types';

/**
 * Resolve a provider spec:
 *   claude          Claude Code CLI (`claude`)
 *   codex           OpenAI Codex CLI (`codex`)
 *   script:<path>   a local module exporting a scripted agent (no LLM)
 */
export async function resolveProvider(spec: string | undefined): Promise<AgentProvider> {
  const value = (spec || process.env.ATLAS_QA_PROVIDER || 'claude').trim();
  if (value === 'claude') return new ClaudeProvider();
  if (value === 'codex') return new CodexProvider();
  if (value.startsWith('script:')) {
    const path = value.slice('script:'.length);
    if (!path) throw new Error('script provider needs a module path, e.g. script:./my-agent.ts');
    return loadScriptedProvider(path);
  }
  throw new Error(`Unknown provider "${value}". Use claude, codex, or script:<path>.`);
}
