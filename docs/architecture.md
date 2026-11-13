# Architecture

The CLI orchestrates one run at a time for an application project. A Bun HTTP server supplies browser tools to the agent. A separate Node process owns Playwright and Chromium. The local React viewer reads the resulting Atlas and QA artifacts.

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
