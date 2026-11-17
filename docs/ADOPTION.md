# Rolling out evidence-backed AI verification

Success is a smaller, reviewable verification loop, not a higher count of AI runs. Assign an engineer to own the goals, evidence review, false-positive triage and provider budget. Keep deterministic tests as the merge gate until live runs demonstrate value on your app.

## Week 1 — establish ground truth

Run `bun run demo:tour` and `bun run eval` with no accounts. Read one FAIL, one healthy control and an INCONCLUSIVE regression test. Agree on three bounded user journeys and known expected outcomes. Use fictional or approved test data in a disposable environment. Record a deterministic baseline and nominate a reviewer who did not write the change.

**Human approval:** the app/data owner approves target URLs, accounts, what may leave the machine, and provider spending before a live run. The reviewer signs off the goals and expected behavior. Agents do not deploy, alter production data, or approve their own results.

## Week 2 — shadow real reviews

Map a small app area with a configured provider and review the Atlas before sharing it. Run the same goals alongside existing CI for about ten changes, including deliberately seeded defects and clean changes. Inspect assertions against screenshots, DOM observations, console/network evidence and requirements. Track defects found, missed known defects, false positives, inconclusive runs, review minutes and reported usage; keep missing cost marked unknown.

**Human approval:** review every published Atlas and every finding. A PASS is advisory; a harness FAIL needs triage because unrelated runtime errors can also fail a run. Archive accepted evidence outside the agent’s write access. Capture CLI/model versions and redact artifacts before sharing.

## Week 3 — choose a narrow operational policy

Select only journeys where evidence has been useful. Pin goals and define who handles flaky selectors, stale Atlas records and quota failures. Set provider-side spending limits and a per-run timeout. Automate artifact collection, but keep deterministic CI and explicit release approval. Run controls after prompt, model, CLI or harness changes; compare detection and false positives, not just success rate.

**Human approval:** a team owner decides whether to expand scope based on measured review effort and errors. A separate human authorizes merges/releases. Stop rollout if reviewers cannot explain a verdict or sensitive data enters artifacts; fix the workflow and repeat the small pilot.

This repository supplies the harness and a scripted benchmark, not evidence that an arbitrary team’s model is reliable. [Failure modes](FAILURE-MODES.md) and [eval limitations](evals.md) are part of the rollout contract.
