// A scripted (no-LLM) QA agent for the Acme Notes demo.
//
//   bun run qa run -p examples/demo-app --url http://127.0.0.1:4400/settings \
//     --goal "Saving settings shows a confirmation" \
//     --provider script:examples/demo-app/agents/scripted-qa.ts
//
// It drives the browser through the same HTTP API a real agent uses with curl,
// then emits the same structured result envelope. Real agents decide what to
// test from the goal; this one follows a fixed plan so results are repeatable.

import type { ScriptedAgentContext } from '../../../src/providers/types';
import { QA_RESULT_END, QA_RESULT_START } from '../../../src/qa/qa-result';

interface Assertion {
  id: string;
  name: string;
  status: 'passed' | 'failed';
  expected: string;
  observed: string;
  evidenceIds: string[];
  atlasSurfaceIds?: string[];
}

export default async function scriptedQa(ctx: ScriptedAgentContext): Promise<string> {
  const browser = ctx.browser;
  const { runId, targetUrl } = ctx.runtime;
  if (!browser || !runId || !targetUrl) throw new Error('scripted-qa needs a browser session, run ID, and target URL');
  const origin = new URL(targetUrl).origin;
  const goal = ctx.prompt.match(/<qa_goal>\n([\s\S]*?)\n<\/qa_goal>/)?.[1] ?? '';
  const testSettings = /setting/i.test(goal) || new URL(targetUrl).pathname.startsWith('/settings');
  const cite = (id: string) => (ctx.runtime.atlasRoot ? { atlasSurfaceIds: [id] } : {});

  ctx.log(`Plan: ${testSettings ? 'save settings' : 'browse notes'} on ${origin}`);
  await browser.waitForReady();
  await browser.navigate(targetUrl);
  await browser.waitForReady();
  const landing = await browser.screenshot({ name: 'landing', runId });
  await browser.clearConsole();
  await browser.clearNetwork();

  const evidence: Array<Record<string, string>> = [
    { id: 'evidence.landing', kind: 'screenshot', label: 'Landing state', ref: landing },
  ];
  const assertions: Assertion[] = [];

  if (testSettings) {
    await browser.navigate(`${origin}/settings`);
    await browser.waitForReady();
    await browser.type('#display-name', 'Sam Example');
    await browser.click('#save-settings');
    await browser.waitForReady();
    const after = await browser.screenshot({ name: 'settings-after-save', runId });
    const status = String(await browser.evaluate("document.querySelector('#status')?.textContent?.trim() ?? ''"));
    evidence.push({ id: 'evidence.settings-after-save', kind: 'screenshot', label: 'Settings page after clicking Save', ref: after });
    assertions.push({
      id: 'assert.settings-save-confirms',
      name: 'Saving settings shows a confirmation message',
      status: status.startsWith('Saved') ? 'passed' : 'failed',
      expected: 'Status reads "Saved. ..." after clicking Save settings',
      observed: status ? `Status reads "${status}"` : 'Status is empty',
      evidenceIds: ['evidence.settings-after-save'],
      ...cite('surface.settings'),
    });
  } else {
    await browser.navigate(`${origin}/`);
    await browser.waitForReady();
    const count = Number(await browser.evaluate("document.querySelectorAll('[data-testid=note-list] .note-card').length"));
    const list = await browser.screenshot({ name: 'note-list', runId });
    evidence.push({ id: 'evidence.note-list', kind: 'screenshot', label: 'Notes list', ref: list });
    assertions.push({
      id: 'assert.notes-listed',
      name: 'The notes list shows existing notes',
      status: count > 0 ? 'passed' : 'failed',
      expected: 'At least one note card',
      observed: `${count} note cards`,
      evidenceIds: ['evidence.note-list'],
      ...cite('surface.notes-list'),
    });
    if (count > 0) {
      await browser.click('[data-testid=note-list] .note-card a');
      await browser.waitForReady();
      const title = String(await browser.evaluate("document.querySelector('[data-testid=note-title]')?.textContent ?? ''"));
      const detail = await browser.screenshot({ name: 'note-detail', runId });
      evidence.push({ id: 'evidence.note-detail', kind: 'screenshot', label: 'Note detail page', ref: detail });
      assertions.push({
        id: 'assert.note-opens',
        name: 'Clicking a note opens its detail page',
        status: title ? 'passed' : 'failed',
        expected: 'The note title is shown',
        observed: title ? `Title "${title}" is shown` : 'No title rendered',
        evidenceIds: ['evidence.note-detail'],
        ...cite('surface.note-detail'),
      });
    }
  }

  const consoleEntries = await browser.console();
  const errors = consoleEntries.filter(entry => entry.level === 'error');
  const network = await browser.network();
  const serverErrors = network.filter(entry => (entry.status ?? 0) >= 500);
  evidence.push({
    id: 'evidence.console',
    kind: 'console',
    label: 'Console after the scoped actions',
    detail: errors.length ? `${errors.length} errors: ${errors.map(e => e.text).join(' | ').slice(0, 500)}` : `${consoleEntries.length} entries, no errors`,
  });
  evidence.push({
    id: 'evidence.network',
    kind: 'network',
    label: 'Network after the scoped actions',
    detail: serverErrors.length ? serverErrors.map(e => `${e.method} ${e.url} -> ${e.status}`).join(' | ') : `${network.length} requests, no 5xx`,
  });

  const failed = assertions.filter(item => item.status === 'failed');
  const findings = failed.length || errors.length || serverErrors.length ? [{
    id: 'finding.settings-save-broken',
    severity: 'major',
    title: testSettings ? 'Saving settings fails' : 'Notes flow is broken',
    details: [
      failed.map(item => `${item.name}: ${item.observed}.`).join(' '),
      serverErrors.length ? `Server returned ${serverErrors.map(e => `${e.status} for ${e.method} ${new URL(e.url).pathname}`).join(', ')}.` : '',
      errors.length ? `Console error: ${errors[0]!.text}` : '',
    ].filter(Boolean).join(' '),
    evidenceIds: [...new Set([...failed.flatMap(item => item.evidenceIds), 'evidence.console', 'evidence.network'])],
    ...(testSettings ? cite('surface.settings') : {}),
  }] : [];
  const verdict = findings.length ? 'fail' : 'pass';
  const summary = verdict === 'pass'
    ? 'All scripted assertions passed with clean console and network.'
    : findings[0]!.details.slice(0, 300);

  const envelope = {
    schemaVersion: 1,
    runId,
    verdict,
    summary,
    assertions,
    evidence,
    findings,
    ...(ctx.runtime.atlasRoot ? { atlasSurfaceIds: [...new Set(assertions.flatMap(item => item.atlasSurfaceIds ?? []))] } : {}),
  };
  return [
    `${verdict.toUpperCase()} — ${summary}`,
    '',
    '## Scope',
    testSettings ? 'Saved the settings form and checked the confirmation.' : 'Opened the notes list and one note.',
    '',
    '## Assertions',
    ...assertions.map(item => `- ${item.status}: ${item.name} (${item.observed})`),
    '',
    QA_RESULT_START,
    JSON.stringify(envelope, null, 2),
    QA_RESULT_END,
  ].join('\n');
}
