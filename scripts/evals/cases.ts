import type { DemoVariant } from '../../examples/demo-app/server';

export interface EvalCase { id: DemoVariant; bug: boolean; path: string; goal: string; defect: string }
const settingsGoal = 'Open Settings, change the display name to Sam Example, save, and verify a Saved confirmation appears with no runtime errors.';
const notesGoal = 'Verify existing notes are listed, then open the first note and verify its title is visible with no runtime errors.';
export const cases: readonly EvalCase[] = [
  { id: 'settings-error', bug: true, path: '/settings', goal: settingsGoal, defect: 'Save returns HTTP 500 and the page throws.' },
  { id: 'settings-silent', bug: true, path: '/settings', goal: settingsGoal, defect: 'Save succeeds but confirmation is missing; no runtime error.' },
  { id: 'notes-empty', bug: true, path: '/', goal: notesGoal, defect: 'Existing seeded notes disappear from the list.' },
  { id: 'note-title-empty', bug: true, path: '/', goal: notesGoal, defect: 'Detail response loses the title while the list remains populated.' },
  { id: 'settings-ok', bug: false, path: '/settings', goal: settingsGoal, defect: 'Healthy settings control.' },
  { id: 'notes-ok', bug: false, path: '/', goal: notesGoal, defect: 'Healthy list/detail control.' },
];

export interface ScoredRun { bug: boolean; verdict: string; durationMs: number }
export function summarize(rows: readonly ScoredRun[]) {
  const bugs = rows.filter(row => row.bug);
  const controls = rows.filter(row => !row.bug);
  const detected = bugs.filter(row => row.verdict === 'fail').length;
  const falsePositives = controls.filter(row => row.verdict === 'fail').length;
  return {
    runs: rows.length, bugRuns: bugs.length, controlRuns: controls.length, detected, falsePositives,
    detectionRate: bugs.length ? detected / bugs.length : null,
    falsePositiveRate: controls.length ? falsePositives / controls.length : null,
    inconclusive: rows.filter(row => row.verdict === 'inconclusive').length,
    warnings: rows.filter(row => row.verdict === 'warnings').length,
    totalRunMs: rows.reduce((sum, row) => sum + row.durationMs, 0),
  };
}
