# ADR 001: The harness computes the final QA verdict

Status: accepted. Documented 2026-11-17.

## Context

A testing agent can claim success, omit runtime errors, clear visible logs, or cite a stale screenshot. Trusting its final prose would make verification circular.

## Decision

Treat provider output as a proposal. Parse a strict result envelope, resolve evidence references, finalize the separate run-scoped browser journal, verify screenshot capture hashes, and then compute/store the verdict. The worker freezes a single snapshot after the provider returns; completeness, runtime checks, and screenshot provenance all use that snapshot. Events received after this explicit cutoff do not extend the observation window. Runtime errors captured through the cutoff force FAIL. Missing evidence, failed providers and interrupted runs produce INCONCLUSIVE. Agent-visible console/network clear operations cannot clear the harness journal.

Implementation: [`runQa`](../../src/qa/qa-runner.ts), [`parseQaResult`](../../src/qa/qa-result.ts), [`corroborateBrowserEvidence` / `validateScreenshotEvidence`](../../src/qa/evidence.ts). [Runner tests](../../src/qa/qa-runner.test.ts) and [real-browser regressions](../../scripts/browser-regressions.ts) include lying PASS, lost journal, tampering, adverse events during final validation, and snapshot stability after the cutoff.

## Alternatives

Accepting prose is convenient but unverifiable. Asking a second model merely moves the trust problem. Deterministic browser tests are stronger for fixed requirements; this harness complements them with exploratory agent-directed actions.

## Consequences

The agent cannot override captured runtime errors through the browser API or its result envelope. That is narrower than tamper-proof: a malicious same-user shell can alter files or the app; semantic assertions can still be wrong. The page under test never gets authority to set the verdict. Humans inspect evidence and independently approve release decisions.
