# Performance measurements

Measured on November 16, 2026, on this Linux x86_64 development machine with Bun 1.4.4, Node 24.22.1, and Chromium 151. Local fixtures only; no live model calls. These are development observations, not capacity or cross-platform claims.

The baseline was f27e8cd; the after measurements use this readiness implementation. Startup, build, and HTTP values are medians of seven sequential runs (ten HTTP requests per run). Startup ends at the first successful readiness response, polled every 5 ms. Builds are in-memory Bun browser builds with minification. Filesystem caches were warm; machine load was not controlled.

| Measurement | Before | After |
| --- | ---: | ---: |
| Server ready | 27.63 ms | 44.92 ms |
| Browser asset build | 57.95 ms | 44.52 ms |
| Local readiness HTTP response | 0.052 ms | 0.049 ms |
| Chromium navigation to usable UI | 134.24 ms | 123.58 ms |
| UI click through two animation frames | 24.00 ms | 30.50 ms |

UI values use seven fresh browser contexts. They include browser scheduling and are too small/noisy to establish an interaction-speed improvement. The HTTP readiness handler is a transport diagnostic, not an end-to-end provider or app query.

The meaningful hotspot was navigation through a large graph: breadth-first search repeatedly scanned every flow and copied the path at each step. An adjacency map and predecessor chain now make that traversal linear in graph size.

| 2,000 surfaces / 1,999 sequential flows (25 samples after 5 warmups) | Before | After |
| --- | ---: | ---: |
| Navigation to last surface | 22.84 ms | 0.81 ms |
| Full deterministic query for that surface | 26.50 ms | 4.76 ms |

The regular five-surface demo is too small to benefit visibly from this change. UI interaction measured switching to Surfaces; its small difference is within scheduling noise. The startup increase includes stricter filesystem and PNG validation dependencies. Build times vary with shared machine load; no build-speed improvement is claimed.

`bun run benchmark` repeats startup/build/readiness measurements. `bun run benchmark:query` repeats the large-graph query measurements. `bun run test:browser` checks the real viewer, clean/failing QA, evidence tampering/loss, screenshot confinement, and cross-origin Ask. Set `ATLAS_QA_CAPTURE_PREVIEW=1` on `bun scripts/browser-smoke.ts` to regenerate the fictional screenshot.
