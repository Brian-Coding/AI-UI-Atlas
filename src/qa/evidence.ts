import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validPngFile } from '../core/png';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrowserDriver } from '../browser/driver';
import { isConsoleError, isConsoleWarning } from '../browser/driver';
import { isPathInside } from '../core/paths';
import type { ParsedQaResult } from './qa-result';

export const hasPngSignature = validPngFile;

function inconclusive(parsed: ParsedQaResult, summary: string, errors: string[]): ParsedQaResult {
  return {
    ...parsed,
    authoritative: false,
    verdict: 'inconclusive',
    summary,
    validationErrors: [...parsed.validationErrors, ...errors],
  };
}

/**
 * Every screenshot the agent cites must be a real PNG inside this run's own
 * screenshot directory (lexically and after resolving symlinks). An agent
 * cannot satisfy the evidence contract with a stale or fabricated path.
 */
export function validateScreenshotEvidence(
  parsed: ParsedQaResult,
  screenshotsDir: string,
  runsRoot: string,
  captures?: Array<{ path: string; sha256: string }>,
): ParsedQaResult {
  if (!parsed.envelope) return parsed;
  const expectedRoot = resolve(screenshotsDir);
  const errors: string[] = [];
  for (const evidence of parsed.envelope.evidence) {
    if (evidence.kind !== 'screenshot') continue;
    const screenshot = evidence.ref ? resolve(evidence.ref) : '';
    if (!screenshot || !screenshot.toLowerCase().endsWith('.png') || !isPathInside(expectedRoot, screenshot)) {
      errors.push(`Screenshot evidence ${evidence.id} is outside this run's screenshot directory`);
      continue;
    }
    if (!existsSync(screenshot)) {
      errors.push(`Screenshot evidence ${evidence.id} does not exist: ${evidence.ref}`);
      continue;
    }
    try {
      const rootInfo = lstatSync(expectedRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        errors.push(`Screenshot evidence ${evidence.id} uses an unsafe screenshot directory`);
        continue;
      }
      const realRoot = realpathSync(expectedRoot);
      if (!isPathInside(realpathSync(runsRoot), realRoot)) {
        errors.push(`Screenshot evidence ${evidence.id} directory resolves outside the runs folder`);
        continue;
      }
      const info = lstatSync(screenshot);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 45 || info.size > 32 * 1024 * 1024) {
        errors.push(`Screenshot evidence ${evidence.id} is not a bounded regular PNG file`);
        continue;
      }
      const realScreenshot = realpathSync(screenshot);
      if (!isPathInside(realRoot, realScreenshot)) {
        errors.push(`Screenshot evidence ${evidence.id} resolves outside this run's screenshot directory`);
        continue;
      }
      if (captures && !captures.some(item => resolve(item.path) === screenshot
        && item.sha256 === createHash('sha256').update(readFileSync(realScreenshot)).digest('hex'))) {
        errors.push(`Screenshot evidence ${evidence.id} was not captured by this run or changed after capture`);
      }
      if (!hasPngSignature(realScreenshot)) {
        errors.push(`Screenshot evidence ${evidence.id} is not a valid PNG file`);
      }
    } catch {
      errors.push(`Screenshot evidence ${evidence.id} could not be resolved`);
    }
  }
  return errors.length === 0 ? parsed : inconclusive(parsed, 'QA screenshot evidence could not be verified.', errors);
}

function nextId(used: Set<string>, base: string): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

/**
 * The harness reads its separate append-only, run-scoped journal and
 * adds them as evidence. Runtime errors force FAIL; warnings or failed
 * requests downgrade PASS to WARNINGS. The agent cannot talk its way past
 * what the browser actually recorded.
 */
export async function corroborateBrowserEvidence(
  parsed: ParsedQaResult,
  driver: BrowserDriver,
  browserSessionId: string,
): Promise<ParsedQaResult> {
  if (!parsed.envelope) return parsed;
  try {
    const status = await driver.status(browserSessionId);
    if (!status.running) {
      return inconclusive(parsed, 'The run did not leave a browser session the harness could verify.', [
        'Harness could not corroborate console or network evidence',
      ]);
    }
    const journal = await driver.readEvidence(browserSessionId);
    if (!journal.complete) return inconclusive(parsed, 'Browser evidence was lost, reset, or overflowed.', ['Incomplete run evidence journal']);
    const consoleEntries = journal.console;
    const networkEntries = journal.network;
    const consoleErrors = consoleEntries.filter(isConsoleError);
    const consoleWarnings = consoleEntries.filter(isConsoleWarning).length;
    const serverErrors = networkEntries.filter(entry => typeof entry.status === 'number' && entry.status >= 500);
    const failedRequests = networkEntries.filter(entry => entry.kind === 'requestfailed').length;

    const usedEvidence = new Set(parsed.envelope.evidence.map(item => item.id));
    const consoleEvidenceId = nextId(usedEvidence, 'evidence.harness-console');
    const networkEvidenceId = nextId(usedEvidence, 'evidence.harness-network');
    const firstErrors = consoleErrors.slice(0, 3).map(entry => entry.text.slice(0, 300));
    const firstServerErrors = serverErrors.slice(0, 3).map(entry => `${entry.method} ${entry.url} -> ${entry.status}`);
    const evidence = [
      ...parsed.envelope.evidence,
      {
        id: consoleEvidenceId,
        kind: 'console' as const,
        label: 'Harness-captured browser console summary',
        detail: `${consoleEntries.length} entries; ${consoleErrors.length} errors; ${consoleWarnings} warnings`
          + (firstErrors.length ? `. First errors: ${firstErrors.join(' | ')}` : ''),
      },
      {
        id: networkEvidenceId,
        kind: 'network' as const,
        label: 'Harness-captured browser network summary',
        detail: `${networkEntries.length} responses/failures; ${serverErrors.length} HTTP 5xx; ${failedRequests} failed requests`
          + (firstServerErrors.length ? `. ${firstServerErrors.join(' | ')}` : ''),
      },
    ];
    const assertions = [...parsed.envelope.assertions];
    const findings = [...parsed.envelope.findings];
    const usedAssertions = new Set(assertions.map(item => item.id));
    const usedFindings = new Set(findings.map(item => item.id));
    let verdict = parsed.verdict;
    let summary = parsed.summary;

    if (consoleErrors.length > 0 || serverErrors.length > 0) {
      assertions.push({
        id: nextId(usedAssertions, 'assert.harness-runtime'),
        name: 'No browser-console errors or HTTP 5xx responses occur',
        status: 'failed',
        observed: `${consoleErrors.length} console errors and ${serverErrors.length} HTTP 5xx responses were captured`,
        evidenceIds: [consoleEvidenceId, networkEvidenceId],
      });
      findings.push({
        id: nextId(usedFindings, 'finding.harness-runtime'),
        severity: 'major',
        title: 'Runtime errors were captured by the harness',
        details: `${consoleErrors.length} console errors and ${serverErrors.length} HTTP 5xx responses occurred during this run.`
          + (firstErrors.length ? ` First console error: ${firstErrors[0]}` : '')
          + (firstServerErrors.length ? ` First 5xx: ${firstServerErrors[0]}` : ''),
        evidenceIds: [consoleEvidenceId, networkEvidenceId],
      });
      if (verdict !== 'fail') summary = 'The harness captured runtime errors during the requested QA flow.';
      verdict = 'fail';
    } else if (consoleWarnings > 0 || failedRequests > 0) {
      assertions.push({
        id: nextId(usedAssertions, 'assert.harness-runtime'),
        name: 'The browser run completes without warnings or failed requests',
        status: 'warning',
        observed: `${consoleWarnings} console warnings and ${failedRequests} failed requests were captured`,
        evidenceIds: [consoleEvidenceId, networkEvidenceId],
      });
      findings.push({
        id: nextId(usedFindings, 'finding.harness-runtime'),
        severity: 'minor',
        title: 'Browser warnings or failed requests were captured',
        details: `${consoleWarnings} console warnings and ${failedRequests} failed requests occurred during this run.`,
        evidenceIds: [consoleEvidenceId, networkEvidenceId],
      });
      if (verdict === 'pass') {
        verdict = 'warnings';
        summary = 'The requested behavior passed, but the harness captured browser warnings or failed requests.';
      }
    }

    const reportBody = [
      parsed.reportBody,
      '## Harness-captured browser evidence',
      `- Console: ${consoleEntries.length} entries; ${consoleErrors.length} errors; ${consoleWarnings} warnings.`,
      `- Network: ${networkEntries.length} responses/failures; ${serverErrors.length} HTTP 5xx; ${failedRequests} failed requests.`,
    ].join('\n\n');
    return {
      ...parsed,
      verdict,
      summary,
      reportBody,
      envelope: { ...parsed.envelope, verdict, summary, assertions, evidence, findings },
    };
  } catch {
    return inconclusive(parsed, 'The harness could not corroborate this run\'s browser evidence.', [
      'Browser evidence corroboration failed',
    ]);
  }
}
