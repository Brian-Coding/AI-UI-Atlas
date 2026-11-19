# Changelog

## Unreleased — 2026-11-18

- Preserve QA goal expectations: prohibit unrequested data setup, fail missing stated state, and retain explicit evidenced failures when dependent checks cannot run.
- Redact scoped browser tokens and credential headers before progress summaries, transcripts, stderr, and QA/Atlas report/state writes.
- Support `atlas --help` / `qa --help` and `-h` with group-specific subcommand help.
- Keep Ask Atlas button labels on one line and explain disabled Ask inline.
- Record Linux live-provider before/after evaluations, including the original goal-substitution false PASS and the limits of a six-case, one-repetition fixture.

- Reject non-string Ask Atlas citations instead of silently dropping malformed entries.
- Reject non-object Atlas manifests and checkpoints before publication, preserving the previous bundle.
- Correct concurrency, verdict and platform documentation; remove unused code and unrelated benchmark branches.
- Preserve reported QA usage when later evidence validation fails.
- Bound media recorder waits and link the current companion project.
- Reject malformed graph field types before publication, preserving the last valid Atlas and preventing viewer failures.
- Separate run evidence from clearable browser buffers; incomplete/lost evidence cannot produce PASS.
- Finalize one worker evidence snapshot at an explicit cutoff for completeness, runtime checks and screenshot provenance; cover events and loss during final validation.
- Write screenshots exclusively beneath checked directories, decode bounded PNGs, and verify QA capture hashes.
- Verify owned POSIX process-group cleanup after timeout/cancellation, including graceful parent exits.
- Require exact viewer origin and a per-launch CSRF token for optional Ask.
- Serialize Atlas operations across processes; make candidate/staging containers self-ignoring.
- Isolate invalid run records; use per-call temporary Ask directories; emit viewer license notices during builds.
- Replace repeated flow scans with indexed navigation; [current measurements, raw samples and reproduction commands](docs/performance.md). Remove historical timing comparisons whose raw samples and exact after commit were not retained.
- Expand real Chromium regressions and document the remaining platform/live-provider validation limits.
- Enforce screenshot size/type bounds before hashing, release completed harness journals in shared workers, and validate nested run-record fields.
- Clean descendant-owned pipes on natural provider exit while retaining the final event.

### Portfolio evidence pass

- Added a six-case real-browser eval with healthy controls, raw results and live-provider flags.
- Made reported usage and missing accounting explicit in reports/viewer.
- Added failure-mode/test mapping, ADRs, team rollout, and reproducible scripted demo media.
