# Architecture

The CLI orchestrates Atlas discovery and QA runs for an application project. A Bun HTTP server supplies browser tools to the agent. A separate Node process owns Playwright and Chromium. The local React viewer reads the resulting Atlas and QA artifacts.

```text
CLI ── Atlas / QA runner ── provider CLI or scripted agent
               │                    │
               │              authenticated HTTP calls
               ▼                    ▼
         artifact store      Bun browser API
                                    │ private worker token
                                    ▼
                           Node + Playwright + Chromium

Viewer ── read APIs ── published Atlas and QA run store
       └─ optional Ask ── provider ── citation validation
```

## Components

| Directory | Responsibility |
| --- | --- |
| `src/cli` | Argument validation, commands, diagnostics, viewer lifecycle |
| `src/atlas` | Discovery prompts, candidates, validation, publication, graph search, Ask, verification history |
| `src/qa` | Test prompts, structured result validation, browser corroboration, report rendering, retention |
| `src/providers` | Claude/Codex arguments and event streams, bounded process lifecycle, scripted extension |
| `src/browser` | Browser interface, worker client, HTTP client, fake driver |
| `scripts/browser-worker*` | Node-owned Playwright sessions and browser operations |
| `src/server` | Loopback guard, tokens, browser routes, artifact-serving routes |
| `src/core` | Atomic files, guarded cleanup, paths, subprocess and bounded-I/O utilities |
| `src/viewer` | React interface and styles, bundled by Bun |
| `examples/demo-app` | Fictional app with a deliberate settings defect and deterministic agent scripts |

Atlas writes a candidate, validates a complete bundle, stages publication, swaps directories, and rolls back on failed publication. QA creates a durable run record, executes the provider, parses a strict result envelope, verifies evidence, then writes Markdown/JSON. Neither depends on another service or repository.

Provider adapters normalize progress, final text, usage, interruption, and errors. The Node worker receives a narrow environment without provider credentials. CLI providers receive the user's provider environment. Screenshot and application data still flow to providers when the agent inspects them.

## Validation

`bun run check` typechecks, runs unit/integration tests, and builds the production viewer. Unit tests use fake browsers and provider subprocess fixtures. `bun run test:browser` drives real Chromium against Acme Notes and the viewer without a paid provider. It verifies a passing flow and an intentionally failing flow, graph publication, query behavior, evidence, API protection, screenshots, and narrow-screen rendering.

Live provider behavior depends on the installed CLI version, model access, sign-in, and account policy. Do not describe a scripted test as a live model test.

## Why the verdict belongs to the harness

The provider chooses browser actions and proposes assertions; it cannot set the final verdict through a browser endpoint. After the provider returns, `runQa` asks the worker to finalize its independent journal. The worker atomically freezes session health, completeness, logs, and screenshot hashes at that observation cutoff. The runner uses the one snapshot for all evidence checks. Clearing agent-visible logs leaves the journal intact. Incomplete journal or invalid evidence yields INCONCLUSIVE; runtime errors captured through the cutoff force FAIL. [ADR 001](decisions/001-verdict.md) and [failure modes](FAILURE-MODES.md) link executable counterexamples.

This separates observation from the agent’s narrative, but does not prove semantic truth. A screenshot of the wrong state can be authentic. DOM evaluation is a tool available to the agent, not an independent oracle for every assertion. Provider shells share OS permissions with the harness, and published reports are ordinary files. Review and archive evidence outside that write scope for higher-trust workflows.

## Transactions and concurrency

Atlas build, resume and discard use a project-scoped process lock so separate CLI processes cannot publish over each other. Candidates are validated before staging; promotion preserves and restores a prior bundle on failure. This is a recoverable filesystem transaction, not a multi-file snapshot for readers during a directory swap. [ADR 004](decisions/004-atlas-publish.md) explains alternatives. QA runs use independent directories and do not take the Atlas lock. Serialize QA runs for a project when retaining surface-verification history: concurrent updates to that shared file can overwrite one another. Also coordinate access to shared app test data.

The Node worker owns isolated browser sessions and a narrow environment; Bun owns orchestration and validation. That extra process boundary costs startup time but avoids relying on Bun to host Playwright’s process machinery. The worker uses its own private token, distinct from the agent-facing browser API. [ADR 003](decisions/003-origin-tokens.md) documents the local-browser threat model.

## What the test layers establish

Unit tests validate parsing, bounds and path rules. Fake-browser integration tests make journal failure and corruption deterministic. Real-process tests prove timeout/root-exit cleanup with inherited pipes. Real Chromium exercises publication, clean/failing QA, tampering and the viewer. The [six-case eval](evals.md) records scripted measurements and Linux live Claude/Codex runs, including a goal-substitution regression. This small fixture does not establish general model detection quality. Native Windows/macOS checks remain unperformed.

[Performance](performance.md) retains current measurements, raw samples, source hashes, and reproduction commands. Historical timing comparisons without retained samples were removed; no speedup is claimed.
