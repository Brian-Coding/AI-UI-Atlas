import { basename, dirname, relative } from 'node:path';
import { slashPath } from '../core/paths';
import type { QaRunRecord, QaVerdict } from './types';

export const VERDICT_LABELS: Record<QaVerdict, string> = {
  pass: 'PASS',
  warnings: 'WARNINGS',
  fail: 'FAIL',
  inconclusive: 'INCONCLUSIVE',
};

function cell(value: string | undefined): string {
  return (value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '-';
}

/**
 * Render report.md for a finished run: the formatted agent narrative followed
 * by the validated structured result. Screenshot links are relative to the
 * report so the folder stays portable.
 */
export function renderRunReport(run: QaRunRecord, narrative: string, reportPath: string): string {
  const lines: string[] = [];
  const verdict = run.verdict ? VERDICT_LABELS[run.verdict] : 'UNKNOWN';
  lines.push(`# QA run ${run.id}: ${verdict}`, '');
  lines.push(`- **Target:** ${run.url}`);
  lines.push(`- **Goal:** ${cell(run.goal)}`);
  if (run.changeDescription) lines.push(`- **Change under test:** ${cell(run.changeDescription)}`);
  lines.push(`- **Provider:** ${run.provider}${run.model ? ` (${run.model})` : ''}`);
  lines.push(`- **Status:** ${run.status}`);
  if (run.startedAt && run.finishedAt) {
    const seconds = Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000);
    lines.push(`- **Duration:** ${seconds}s`);
  }
  if (run.atlasUsed) lines.push('- **UI Atlas:** consulted');
  if (run.usage?.costUsd !== undefined) lines.push(`- **Reported cost:** $${run.usage.costUsd.toFixed(4)}`);
  lines.push('');

  if (run.validationErrors?.length) {
    lines.push('## Harness validation', '', 'The agent\'s result did not meet the evidence contract, so the verdict is INCONCLUSIVE:', '');
    for (const error of run.validationErrors) lines.push(`- ${error}`);
    lines.push('');
  }

  if (run.assertions?.length) {
    lines.push('## Assertions', '', '| Status | Assertion | Observed | Evidence |', '| --- | --- | --- | --- |');
    for (const assertion of run.assertions) {
      lines.push(`| ${assertion.status} | ${cell(assertion.name)} | ${cell(assertion.observed)} | ${assertion.evidenceIds.join(', ') || '-'} |`);
    }
    lines.push('');
  }

  if (run.findings?.length) {
    lines.push('## Findings', '');
    for (const finding of run.findings) {
      lines.push(`### [${finding.severity}] ${finding.title}`, '', finding.details, '', `Evidence: ${finding.evidenceIds.join(', ') || '-'}`, '');
    }
  }

  if (run.evidence?.length) {
    lines.push('## Evidence', '');
    const reportDir = dirname(reportPath);
    for (const item of run.evidence) {
      if (item.kind === 'screenshot' && item.ref) {
        const rel = slashPath(relative(reportDir, item.ref));
        lines.push(`- **${item.id}** (${item.kind}): ${item.label}`, '', `  ![${basename(item.ref)}](${rel})`, '');
      } else {
        lines.push(`- **${item.id}** (${item.kind}): ${item.label}${item.detail ? `: ${cell(item.detail)}` : ''}`);
      }
    }
    lines.push('');
  }

  lines.push('## Agent report', '', narrative.trim() || '(No narrative was produced.)', '');
  return lines.join('\n');
}
