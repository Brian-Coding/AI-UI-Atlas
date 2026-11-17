# Contributing

Help make application maps clearer and QA findings easier to reproduce. A useful bug report includes the command, expected result, actual result, runtime versions, and a minimal fictional app that demonstrates the problem. Review reports and screenshots for private data before attaching them.

## Local development

Install Bun 1.4.4 or newer (tested with 1.4.4) and Node.js 20+, then:

```bash
bun install --frozen-lockfile
bun run browsers:install
bun run check
bun run test:browser
```

`bun test` uses temporary directories, fake browser drivers, and scripted providers. `bun run test:browser` starts Acme Notes on an available loopback port and uses real Chromium to validate Atlas publication, graph queries, successful and failing QA, worker authentication, and the viewer. It cleans up its servers and temporary project. Neither command contacts an LLM.

`bun run build` bundles the viewer into ignored `dist/`. The `serve` command bundles the same source through Bun's HTML support; you do not need to build before running it.

To explore the product interactively, run `bun run demo:tour`, then `bun run serve examples/demo-app`. Run `bun run demo` in another terminal to keep the sample app available at port 4400.

## Changes

Keep changes focused and describe the behavior a user can observe. Add regression tests for meaningful logic or failure cases. Validate affected browser flows with the real browser test when changing the worker, viewer, or runner integration.

- Provider flags and event handling belong in `src/providers/`.
- Atlas schema and publication logic belong in `src/atlas/`.
- QA evidence and verdict logic belong in `src/qa/`.
- Browser sessions and HTTP access must keep their confinement and authentication checks.
- Use the existing guarded filesystem utilities for generated-directory cleanup.
- Do not put live accounts, personal paths, actual conversations, credentials, or customer screenshots in fixtures. Acme Notes and `app.test` are fictional examples.

A pull request should explain the problem, the resulting behavior, and the checks run. State explicitly if a real provider was tested; passing scripted tests does not establish live provider compatibility.

See [architecture](docs/architecture.md), [artifact format](docs/artifacts.md), and [security](docs/security.md) before changing their contracts. Contributions are made under the [MIT license](LICENSE).

## Portfolio evidence and reproducible demos

Read [failure modes](docs/FAILURE-MODES.md) and [decisions](docs/decisions/README.md) when changing a trust boundary. `bun run eval` runs planted defects and healthy controls through real Chromium. Keep inconclusive runs in denominators and publish raw data when claiming a detection rate. `bun run media` regenerates the fictional recording; inspect frames before committing. See [media instructions](docs/media.md).
