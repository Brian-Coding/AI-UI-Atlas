import { expect, test } from 'bun:test';
import { buildQaSystemPrompt, buildQaTaskPrompt } from './qa-prompt';

test('QA instructions preserve expected state and distinguish failed prerequisites from blocked checks', () => {
  const prompt = buildQaSystemPrompt({ apiBase: 'http://localhost:1234', token: 'test-token',
    runId: 'test', browserSessionId: 'test', screenshotDir: '/tmp/shots', timeoutMinutes: 5 });
  expect(prompt).toContain('Do not create, edit, or delete app data');
  expect(prompt).toContain('unless the goal explicitly asks');
  expect(prompt).toContain('missing expected state is a failed assertion');
  expect(prompt).toContain('Record a finding with evidence');
  expect(prompt).toContain('dependent checks as not_run');
  expect(prompt).not.toContain('If a feature needs specific data, create it');
  expect(prompt).not.toContain('notes-empty');
  expect(prompt).not.toContain('settings-silent');
});

test('task preserves an explicit request to create data without silently adding setup', () => {
  const goal = 'Create a draft, then verify it appears in the list.';
  expect(buildQaTaskPrompt({ runId: 'test', browserSessionId: 'test', url: 'http://app.test', goal }))
    .toContain(`<qa_goal>\n${goal}\n</qa_goal>`);
});
