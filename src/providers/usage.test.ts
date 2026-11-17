import { expect, test } from 'bun:test';
import { createClaudeStreamState, handleClaudeEvent } from './claude';
import { createCodexStreamState, handleCodexEvent } from './codex';

test('Claude reports aggregate/cache tokens and zero cost; malformed and missing values stay unknown', () => {
  const state = createClaudeStreamState();
  handleClaudeEvent({ type: 'result', total_cost_usd: 0, usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 3, output_tokens: 4 } }, state);
  expect(state.usage).toEqual({ inputTokens: 33, outputTokens: 4, costUsd: 0 });
  handleClaudeEvent({ type: 'result', total_cost_usd: -1, usage: { input_tokens: '12', output_tokens: Infinity } }, state);
  expect(state.usage).toEqual({ inputTokens: undefined, outputTokens: undefined, costUsd: undefined });
});

test('Codex sums completed turns without inventing cost or adding extra fields to output', () => {
  const state = createCodexStreamState();
  handleCodexEvent({ type: 'turn.completed', usage: {} }, state);
  expect(state.usage).toEqual({});
  for (let i = 0; i < 2; i++) handleCodexEvent({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 0, reasoning_output_tokens: 3 } }, state);
  expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 0 });
});
