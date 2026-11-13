# Getting started

## Install and check the runtime

Use Bun 1.3+ for the application and Node.js 20+ for the Playwright worker. Linux, macOS, and Windows paths are supported; the automated browser smoke test is also useful for checking a new machine.

```bash
git clone https://github.com/Brian-Coding/AI-UI-Atlas-QA-Tester.git
cd AI-UI-Atlas-QA-Tester
bun install --frozen-lockfile
bun run browsers:install
bun run doctor
```

Doctor checks runtime executables, the Chromium installation, and provider CLI versions. Missing providers are informational because the scripted tour works without them. Doctor does not verify provider sign-in or launch a model session.

On Linux, if Chromium reports missing shared libraries, run `bunx playwright install --with-deps chromium`. Installing operating-system dependencies may require administrator privileges. A headed browser needs a display; headless is the default.

## Take the Acme Notes tour

```bash
bun run demo:tour
bun run serve examples/demo-app
```

The tour uses real Chromium and a fixed, inspectable script. It writes a five-surface Atlas and a QA run showing that settings save fails. The app's HTTP 500 is deliberate. Open the viewer URL and explore Surfaces, Entities, Flows, Gallery, Ask Atlas, and QA runs. The **Search atlas** button works without a model.

To query from the terminal:

```bash
bun run atlas query -p examples/demo-app "where are tags shown?"
bun run atlas show surface.settings -p examples/demo-app
bun run qa list -p examples/demo-app
```

The tour shuts its app down after collecting evidence. Run `bun run demo` in a separate terminal to interact with Acme Notes at <http://127.0.0.1:4400>.

## Map your own app

Start your development server using its normal command. Ensure the app is reachable from this machine. Install and authenticate one supported provider CLI in the same environment, and check `claude --version` or `codex --version`.

From the UI Atlas + QA checkout:

```bash
bun run atlas build /path/to/app --url http://localhost:3000 --provider claude
```

The agent reads the application's source, explores its UI, captures screenshots, and writes a candidate bundle. You see progress on stderr. A validated, successful build publishes to `/path/to/app/docs/ui-atlas`. To concentrate discovery, add `--focus "note editing and settings"`. This guides emphasis; it is not a strict exclusion boundary.

## Test a change

```bash
bun run qa run -p /path/to/app --url http://localhost:3000 --goal "Create a note, open it, and confirm the saved title" --change "Updated note creation" --provider codex
bun run serve /path/to/app --allow-ask --provider codex
```

The runner uses the published Atlas when present. The viewer's **Ask LLM** button is enabled only with `--allow-ask`; it uses the selected provider and may incur provider charges. Runs are started from the CLI. The viewer inspects artifacts and answers questions.

## If something stops

- **No provider executable:** install the provider or set `ATLAS_QA_CLAUDE_BIN` / `ATLAS_QA_CODEX_BIN` to its executable path. Sign in outside the harness first.
- **Missing Chromium:** run `bun run browsers:install` again after a Playwright update. Confirm the worker uses the intended Node with `ATLAS_QA_NODE`.
- **Inconclusive QA:** read the validation section in the report. Authentication failures, missing screenshots, invalid agent output, and interrupted providers cannot establish a passing result.
- **Paused or failed Atlas:** use `bun run atlas status /path/to/app`, then `bun run atlas resume /path/to/app --provider claude`. To abandon the candidate, use `atlas discard`; it preserves the published Atlas.
- **Login required in the app:** every run starts a fresh browser context. Use test credentials and a test environment. There is no saved-login import or interactive checkpoint feature; headed mode shows the browser but does not pause the agent for you.
- **Viewer port busy:** add `--port 0` to choose an available port. Atlas builds and QA runs already use temporary ports.

`Ctrl+C` asks a CLI run to stop and retain its report or checkpoint. A second `Ctrl+C` exits immediately. Reload the viewer after rebuilding the Atlas to load the newly published graph.
