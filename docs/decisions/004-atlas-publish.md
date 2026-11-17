# ADR 004: Validate a staged Atlas before replacing the published bundle

Status: accepted. Documented 2026-11-17.

## Context

Discovery produces multiple related files and screenshots. An interrupted or malformed build must not replace a usable map with half a bundle. Two writers also need a common project lock.

## Decision

Write into a candidate directory, validate graph fields/references/files, stage a complete bundle and promote it under the project lock. Keep a backup during replacement and restore it on failure. Preserve resumable candidates and the prior published Atlas until promotion succeeds.

Implementation: [`withProjectLock`](../../src/core/project-lock.ts), [`validateAtlasBundle` / `promoteAtlasCandidate`](../../src/atlas/atlas-artifacts.ts). [Artifact tests](../../src/atlas/atlas-artifacts.test.ts), [cross-process lock test](../../src/atlas/atlas-lock.integration.test.ts) and [browser regressions](../../scripts/browser-regressions.ts) cover malformed optional graph fields and the retained viewer.

## Alternatives

Writing directly into the published directory is simpler but exposes partial state. A database transaction would centralize atomicity but makes the portable, reviewable artifact format harder to inspect and distribute.

## Consequences

Failures preserve the last usable bundle and produce actionable validation errors. Directory replacement/rollback is not a database snapshot for concurrent readers; a reader may need to retry during a swap. Candidates consume disk until cleaned. Provider shell access remains outside this cooperative lock contract.
