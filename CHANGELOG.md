# Changelog

## Unreleased — 2026-11-16 (private preview)

- Reject non-string Ask Atlas citations instead of silently dropping malformed entries.
- Reject non-object Atlas manifests and checkpoints before publication, preserving the previous bundle.
- Correct concurrency, verdict and platform documentation; remove unused code and unrelated benchmark branches.
- Preserve reported QA usage when later evidence validation fails.
- Bound media recorder waits and link the current companion project.
- Reject malformed graph field types before publication, preserving the last valid Atlas and preventing viewer failures.
- Separate run evidence from clearable browser buffers; incomplete/lost evidence cannot produce PASS.
- Write screenshots exclusively beneath checked directories, decode bounded PNGs, and verify QA capture hashes.
- Verify owned POSIX process-group cleanup after timeout/cancellation, including graceful parent exits.
- Require exact viewer origin and a per-launch CSRF token for optional Ask.
- Serialize Atlas operations across processes; make candidate/staging containers self-ignoring.
- Isolate invalid run records; use per-call temporary Ask directories; emit viewer license notices during builds.
- Replace repeated flow scans with indexed navigation; [historical observations and reproduction commands](docs/performance.md).
- Expand real Chromium regressions and document the remaining platform/live-provider validation limits.
- Enforce screenshot size/type bounds before hashing, release completed harness journals in shared workers, and validate nested run-record fields.
- Clean descendant-owned pipes on natural provider exit while retaining the final event.

### Portfolio evidence pass

- Added a six-case real-browser eval with healthy controls, raw results and live-provider flags.
- Made reported usage and missing accounting explicit in reports/viewer.
- Added failure-mode/test mapping, ADRs, team rollout, and reproducible scripted demo media.
