import { expect, test } from 'bun:test';
import { summarize } from './cases';

test('eval denominators retain inconclusive and warning runs instead of inflating detection', () => {
  expect(summarize([
    { bug: true, verdict: 'fail', durationMs: 10 },
    { bug: true, verdict: 'inconclusive', durationMs: 20 },
    { bug: false, verdict: 'fail', durationMs: 30 },
    { bug: false, verdict: 'warnings', durationMs: 40 },
  ])).toEqual({ runs: 4, bugRuns: 2, controlRuns: 2, detected: 1, falsePositives: 1,
    detectionRate: 0.5, falsePositiveRate: 0.5, inconclusive: 1, warnings: 1, totalRunMs: 100 });
  expect(summarize([]).detectionRate).toBeNull();
});
