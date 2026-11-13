# CLI and configuration

Run commands from the cloned tool repository, or invoke its `src/cli/main.ts` with Bun by absolute path. There is no required global package installation.

```bash
bun run cli --help
bun run atlas build --help
bun run qa run --help
```

## Commands

| Command after `bun run cli` | Purpose |
| --- | --- |
| `atlas build [projectDir] --url URL` | Discover or update an Atlas |
| `atlas resume [projectDir]` | Resume the last failed/paused candidate |
| `atlas status [projectDir]` | Inspect publication and latest build |
| `atlas discard [projectDir]` | Remove a stopped candidate |
| `atlas validate [projectDir]` | Validate the published bundle |
| `atlas query "question" -p projectDir` | Search without a provider |
| `atlas show ID -p projectDir` | Print an exact graph record |
| `atlas ask "question" -p projectDir` | Ask a provider with validated citations |
| `qa run --url URL --goal "goal" -p projectDir` | Execute a QA run |
| `qa rerun RUN_ID -p projectDir` | Test a prior goal again |
| `qa list -p projectDir` | List runs, newest first |
| `qa show RUN_ID -p projectDir` | Print a report |
| `serve [projectDir]` | Serve the local viewer |
| `doctor` | Check installed runtimes and CLIs |

`bun run atlas …`, `bun run qa …`, and `bun run serve …` are shortcuts. Project defaults to the current directory. `-p` / `--project` selects it explicitly. A positional project directory takes precedence where one is supported. Questions and goals containing spaces should be quoted.

## Providers and common controls

`--provider claude` is the default, unless `ATLAS_QA_PROVIDER` is set. `--provider codex` selects Codex. `--provider script:./agent.ts` loads a trusted local module exporting a function. The script path is relative to the shell's working directory, not `--project`.

Model-running commands support `--model`, `--timeout` in minutes, and `--quiet` (`-q`). Codex also accepts `--reasoning` (`low`, `medium`, `high`, or `xhigh`, depending on model support), defaulting to high. Omit `--model` to use your provider CLI's configured default. Atlas build/resume and QA support `--headed`; Ask Atlas has no browser. Most result commands accept `--json`.

The viewer defaults to port 4477. `--port 0` chooses a free port. `--allow-ask` enables LLM questions with `--provider` and optional `--model`. It does not enable browser-driven QA commands in the UI.

## Environment

| Variable | Meaning |
| --- | --- |
| `ATLAS_QA_PROVIDER` | Default provider specification |
| `ATLAS_QA_CLAUDE_BIN` | Explicit Claude executable path |
| `ATLAS_QA_CODEX_BIN` | Explicit Codex executable path |
| `ATLAS_QA_NODE` | Node executable for the browser worker |
| `ATLAS_QA_HEADED=1` | Show Chromium by default |
| `ATLAS_QA_SLOWMO` | Browser action delay in milliseconds (0 headless, 250 headed by default; capped at 10000) |
| `ATLAS_QA_DATA_DIR` | Scratch-data directory override |
| `PLAYWRIGHT_BROWSERS_PATH` | Optional Playwright browser installation location |
| `PORT` | Acme Notes demo port only (default 4400) |

Provider CLIs use their existing sign-in and environment configuration. No API key file is required by this tool. Avoid creating a tracked `.env` file; the repository ignores `.env` and `.env.*`.

## Storage

| Location under the app project | Contents |
| --- | --- |
| `docs/ui-atlas/` | Published Atlas, Markdown, graph, metadata, screenshots |
| `docs/.ui-atlas-candidates/` | In-progress Atlas candidates |
| `.atlas-qa/atlas-run.json` | Latest Atlas run state |
| `.atlas-qa/atlas-transcripts/` | Provider event streams from Atlas runs |
| `.atlas-qa/runs/` | QA records and evidence |
| `.atlas-qa/surface-verifications.json` | Last passing QA observation per surface |

`.atlas-qa/` creates its own ignore file. Add `docs/.ui-atlas-candidates/`, `docs/.ui-atlas-publish-*/`, and `docs/.ui-atlas-rollback-*/` to the app's `.gitignore`. Review published Atlas files before choosing to commit them.

Scratch data defaults to `%LOCALAPPDATA%\ui-atlas-qa` on Windows or `$XDG_DATA_HOME/ui-atlas-qa` / `~/.local/share/ui-atlas-qa` elsewhere. It contains Ask scratch space and ad-hoc screenshots. No Agent Forge state or installation is read.
