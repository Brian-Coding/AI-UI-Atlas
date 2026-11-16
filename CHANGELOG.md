# Changelog

## 0.1.1 — 2026-11-16 (private preview)

- Separate run evidence from clearable browser buffers; incomplete/lost evidence cannot produce PASS.
- Write screenshots exclusively beneath checked directories, decode bounded PNGs, and verify QA capture hashes.
- Verify owned POSIX process-group cleanup after timeout/cancellation, including graceful parent exits.
- Require exact viewer origin and a per-launch CSRF token for optional Ask.
- Serialize Atlas operations across processes; make candidate/staging containers self-ignoring.
- Isolate invalid run records; use per-call temporary Ask directories; emit viewer license notices during builds.
- Replace repeated flow scans with indexed navigation. On a 2,000-surface fixture, median navigation fell from 22.84 ms to 0.81 ms; [method and other measurements](docs/performance.md).
- Expand real Chromium regressions and document the remaining platform/live-provider validation limits.
