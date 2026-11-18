# Browser QA with evidence

Give the tester an observable goal. It uses your chosen model to plan checks, drive Chromium, inspect screenshots, and explain failures. If the project has an Atlas, the agent reads it before planning and cites the surfaces it exercises.

```bash
bun run qa run -p /path/to/app --url http://localhost:3000 --goal "Create a note, open it, and confirm the title survives a reload" --change "Changed the save handler" --provider codex
```

Use a specific goal and test data. QA may mutate the application through the UI. Source changes are forbidden by the tester prompt, but this is an instruction to the model rather than an operating-system restriction.

## Understand the verdict

| Verdict | Meaning | CLI exit code |
| --- | --- | --- |
| PASS | The submitted assertions passed and satisfied the evidence contract | 0 |
| WARNINGS | Checks completed with warnings or minor findings | 0, or 1 with `--fail-on-warnings` |
| FAIL | An assertion failed, a major/critical finding was reported, or runtime errors were captured | 1 |
| INCONCLUSIVE | The run could not establish a trustworthy verdict | 2 |

Invalid command arguments and setup errors exit 1. A QA `status` describes execution; a `verdict` describes the tested behavior. For example, a completed run can correctly report FAIL.

The agent must return a structured result tied to this run ID. Assertions and findings cite evidence IDs. PASS requires passing assertions, screenshot evidence, console evidence, and no minor, major, or critical findings; informational notes are allowed. Referenced screenshots must be PNG files confined to the run's screenshot directory. The harness independently collects an append-only journal that starts before the provider runs: console errors or HTTP 5xx force FAIL; console warnings or failed requests can downgrade PASS to WARNINGS. Interrupted or failed providers cannot establish a pass.

After the provider returns, the harness asks the worker to finalize the journal before validating evidence. The worker checks session health and freezes completeness, console/network entries, and screenshot capture hashes together, without yielding to another event. That operation is the explicit observation cutoff, recorded as `finalizedAt` in the snapshot. Both runtime corroboration and screenshot provenance use that same snapshot. Repeated finalization returns identical evidence; browser events received after the cutoff and subsequent session cleanup cannot change it. This does not wait for every possible background request or timer to finish.

These checks make reports inspectable, not infallible. A model can misunderstand a requirement or miss a screen. Agent-visible console/network buffers are bounded and may be cleared for inspection. Those operations do not clear the harness journal. Events received by the worker from journal creation through finalization, including initial navigation, count. A replaced/lost session or journal overflow before the cutoff yields INCONCLUSIVE; it cannot refresh a passing verification. Screenshot evidence must decode as a bounded PNG and match the path and hash in the finalized snapshot. Keep conventional tests for repeatable regression coverage.

## Inspect, repeat, and retain

```bash
bun run qa list -p /path/to/app
bun run qa show RUN_ID -p /path/to/app
bun run qa rerun RUN_ID -p /path/to/app --provider codex
bun run serve /path/to/app
```

Replace `RUN_ID` with an ID from `qa list`. Rerun reuses the prior target URL, goal, and change description. Provider, model, timeout, and Atlas use follow the current command's configuration; they are not a replay of the prior provider session.

Each run saves `report.md`, `report.json`, its durable `run.json`, prompts, agent output, optional provider transcript, and screenshots in `.atlas-qa/runs/<runId>/`. Markdown screenshot links are relative so the report folder can be shared as a unit. Review and redact artifacts before sharing.

The default retention target is 50 runs. `--keep-runs 100` changes it for that invocation. Active runs are never pruned. Directories with unexpected content are preserved instead of deleted automatically. Abrupt machine or process termination can leave a queued/running QA record; such a run has no accepted verdict and cannot be resumed. Start a new run.

## Useful controls

- `--no-atlas`: plan from the app and goal without the published map; does not update Atlas verification history.
- `--headed`: show the browser. A desktop display is required.
- `--timeout 10`: cap provider execution at ten minutes; the default is 30.
- `--json`: print the result record on stdout for automation; progress is suppressed.
- `--fail-on-warnings`: make warnings fail a CI command.

For deterministic automation without a provider account, use `--provider script:./your-agent.ts`. [Artifact format](artifacts.md) describes the extension point. `bun run test:browser` is the repository's complete example of using the product in an automated real-browser check.
