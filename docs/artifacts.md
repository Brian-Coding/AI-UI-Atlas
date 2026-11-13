# Artifact format and scripted agents

## Published Atlas

`docs/ui-atlas/` is a portable bundle:

| File | Purpose |
| --- | --- |
| `atlas.json` | Versioned graph of surfaces, entities, and flows |
| `atlas.md` | Narrative map, code references, observations, and open questions |
| `manifest.json` | Schema version, run ID, timestamp, and completion status |
| `checkpoint.json` | Completed surface IDs and discovery progress |
| `changelog.md` | Changes since the previous map |
| `README.md` | How to read this particular app's Atlas and its limitations |
| `shots/*.png` | Screenshot evidence referenced by the graph |

Graph schema version 1 uses stable lowercase IDs such as `surface.notes-list`, `entity.note`, and `flow.open-note`. Each record has a name. Surfaces can list routes, reach instructions, actions, states, `entityIds`, `codeRefs`, and relative `screenshotRefs`. Flows name `fromSurfaceId`, `toSurfaceId`, and a trigger. Entities list fields and source references.

The authoritative type definitions and validator live in [atlas-artifacts.ts](../src/atlas/atlas-artifacts.ts). The [discovery prompt](../src/atlas/atlas-prompt.ts) contains a complete agent-facing bundle specification. `bun run atlas validate -p /path/to/app` checks a published bundle using the same validator used before publication.

The harness rejects duplicate or unknown IDs, missing required files, inconsistent counts/completion metadata, unsafe evidence paths, and missing PNG evidence for verified surfaces. Structural validity does not guarantee full coverage or accurate code references.

## QA result envelope

Providers return final text containing exactly one `QA_RESULT_JSON_START` / `QA_RESULT_JSON_END` block. Its JSON includes `schemaVersion: 1`, the exact `runId`, a `verdict`, a summary, and arrays of assertions, evidence, and findings.

Assertions have an ID, name, status, and evidence IDs, plus optional expected/observed text and Atlas surface IDs. Evidence identifies a screenshot, console/network observation, or other observation. Screenshot `ref` values are the absolute PNG paths returned by the browser API. Findings cite evidence and have `critical`, `major`, `minor`, or `note` severity.

See [types](../src/qa/types.ts), [result validation](../src/qa/qa-result.ts), and the [scripted QA example](../examples/demo-app/agents/scripted-qa.ts) for the full contract. The runner adds its own browser evidence before persisting the result. Saved Markdown uses relative image links; JSON preserves the run's absolute screenshot references.

## Write a scripted agent

A scripted provider is a trusted TypeScript module, loaded in the Bun process. It makes the same authenticated browser calls as a model-driven agent. Use it for deterministic checks or reproducing a harness bug without model calls.

```typescript
import type { ScriptedAgent } from './src/providers/types';

const agent: ScriptedAgent = async ({ browser, runtime, signal, log }) => {
  if (!browser || !runtime.targetUrl) throw new Error('This script needs a browser run');
  if (signal.aborted) throw new Error('Stopped');
  await browser.navigate(runtime.targetUrl);
  await browser.waitForReady();
  const screenshot = await browser.screenshot({ name: 'landing' });
  log(`Captured ${screenshot}`);
  // Inspect the page, collect assertions, and return a complete QA envelope.
  // The bundled scripted-qa.ts shows both passing and failing envelopes.
  return 'INCONCLUSIVE: this minimal example collects a screenshot only.';
};
export default agent;
```

Save that example at the tool repository root and invoke `--provider script:./your-agent.ts`. It intentionally returns an inconclusive report until you add a full result envelope. The complete [Acme Notes QA agent](../examples/demo-app/agents/scripted-qa.ts) and [Atlas agent](../examples/demo-app/agents/scripted-atlas.ts) are runnable references.

Scripts receive a cancellation signal and must cooperate with it. A timeout stops waiting for the function and closes its browser session; it cannot forcibly interrupt arbitrary JavaScript or undo filesystem side effects. Load only scripts you trust.
