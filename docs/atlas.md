# Build and query an Atlas

An Atlas connects three kinds of records:

| Record | Example | What it explains |
| --- | --- | --- |
| Surface | `surface.note-detail` | A screen, dialog, tab, or meaningful UI state; its route, actions, code, and screenshots |
| Entity | `entity.note` | Data fields and the surfaces that display them |
| Flow | `flow.open-note` | How an action connects two surfaces |

## Discover and update

```bash
bun run atlas build /path/to/app --url http://localhost:3000 --provider claude
bun run atlas validate /path/to/app
bun run serve /path/to/app
```

Discovery reads source structure and data types, walks the browser, reconciles code with observations, explores difficult states, and writes its findings. Each surface is marked `verified`, `partial`, `unverified`, or `excluded`. **Verified means the surface was observed with screenshot evidence; it does not mean every behavior passed QA.** Open questions document coverage gaps.

Running `build` again asks the agent to update the existing map while preserving stable IDs. Candidates live under `docs/.ui-atlas-candidates/<runId>/`. The harness checks IDs, references, counts, completion metadata, and PNG evidence before replacing `docs/ui-atlas/`. Failed or interrupted provider runs preserve the candidate and the previous published bundle.

Atlas discovery defaults to a three-hour execution limit. Set a smaller limit with `--timeout 30` (minutes). `--headed` shows the browser; headless is the default.

## Recover a run

```bash
bun run atlas status /path/to/app
bun run atlas resume /path/to/app --provider claude
bun run atlas discard /path/to/app
```

Resume reuses the candidate and passes its validation errors back to the agent. It retains the original model unless you specify another. Pass `--url` if your dev server moved. Discard deletes the generated candidate and run state while leaving the published map alone. An atomic project lock enforces one build, resume, or discard at a time across CLI processes. A lock owned by an exited process can be reclaimed; live or reused PIDs are conservatively refused.

## Search and Ask Atlas

```bash
bun run atlas query -p /path/to/app "where are tags shown?"
bun run atlas query -p /path/to/app "how do I get to settings?"
bun run atlas show surface.note-detail -p /path/to/app
bun run atlas ask -p /path/to/app "which surfaces would a note title change affect?" --provider codex
```

`query` ranks records and follows graph edges locally. It is an offline search with some navigation and entity-to-screen interpretation, not a general language model. An unmatched query exits 1. `show` prints one exact record.

`ask` launches an analyst with instructions to read only the published Atlas. The harness rejects unknown citations and malformed answers. Citation validation proves that referenced IDs exist; it does not prove that every statement is correct. The provider still has broad filesystem permissions, as described in [security](security.md).

Start the viewer with `--allow-ask --provider codex` for the same LLM question workflow in the browser. Offline search is always available when an Atlas exists.

## Use the map in QA

QA prompts include the Atlas location and ask the agent to derive assertions from relevant surfaces. An accepted PASS records exercised surface IDs in `.atlas-qa/surface-verifications.json`. The viewer displays the last passing QA run separately from discovery status. Rebuilding retains verification entries for surviving IDs; this history is not proof that the newly changed app has been retested.

See [artifact format](artifacts.md) for the files and schema.

Candidate and staging containers (`docs/.ui-atlas-candidates/` and `docs/.ui-atlas-staging/`) contain their own `.gitignore` so external target repositories do not accidentally stage unfinished evidence. The final `docs/ui-atlas/` bundle remains shareable after inspection. Interrupted artifacts can contain private data.

Ask uses a fresh temporary working directory for each call and removes it on completion. Projects with the same basename do not share scratch state.
