# Performance measurements

Current measurements were collected on November 17, 2026, on Linux x86_64 with Bun 1.4.4 and Node v24.22.1. Local fixtures only; no live model calls. These are development observations, not capacity or cross-platform claims.

[Retained raw samples](performance-current.json) were recorded at commit `5350cd3` (the evidence-finalization fix) with runtime versions and workload sizes. Earlier before/after tables were removed because their raw samples were not retained. No measured speedup is claimed.

| Current measurement | Median | Retained samples |
| --- | ---: | ---: |
| Server ready | 34.44 ms | 7 launches |
| Browser asset build | 32.73 ms | 7 builds |
| Local readiness HTTP response | 0.038 ms | 70 requests |
| Graph navigation to last surface | 0.59 ms | 25 traversals |
| Full deterministic query for that surface | 4.57 ms | 25 queries |

Startup ends at the first successful readiness response, polled every 5 ms. Each launch uses a fake browser driver and ten sequential HTTP requests. Builds are in-memory Bun browser builds with minification. The readiness endpoint is a transport diagnostic; it does not measure a provider or an end-to-end app query. Filesystem caches were warm; machine load was not controlled. The scripts preserve raw samples in execution order; medians use the middle value, or the average of the two middle values for even sample counts.

The graph workload contains 2,000 surfaces and 1,999 sequential flows, with five warmups followed by 25 samples for each operation. Navigation uses an adjacency map and predecessor chain to avoid repeated full-flow scans and path copying. That traversal is linear in graph size. The regular five-surface demo is too small to demonstrate a useful performance difference.

Reproduce from the repository root after `bun install --frozen-lockfile`:

```bash
bun run benchmark > /tmp/atlas-server-samples.json
bun run benchmark:query > /tmp/atlas-query-samples.jsonl
```

The first command emits startup/build/readiness summaries and their raw arrays. The second emits one summary and raw array per graph operation. Compare those arrays with the retained file, allowing for machine load and runtime differences. `bun run test:browser` separately checks the real viewer, clean/failing QA, evidence finalization and tampering/loss, screenshot confinement, and cross-origin Ask.
