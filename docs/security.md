# Security and data

UI Atlas + QA is a local development tool. Point it at an app and repository you are authorized to test, with recoverable test data.

## Agent permissions

Claude runs with `--dangerously-skip-permissions`; Codex runs with `--dangerously-bypass-approvals-and-sandbox`. This permits unattended shell and image tools. Their access is broader than the app's browser session. Atlas discovery reads project source and writes documentation. QA is instructed to test without changing source. Ask Atlas is instructed to read only. Those instructions are not a filesystem sandbox.

Do not treat untrusted apps, Atlas text, or questions as safe instructions merely because they are being tested. Prompts explicitly tell the agent to treat them as data, but model behavior remains a trust boundary. Use an isolated development environment for untrusted projects.

## Local services

The Bun server binds only to loopback. API requests require the exact bound scheme, hostname, and port; another loopback name is a different origin. Browser-control endpoints require a random token. Optional Ask requires a separate same-origin CSRF token and JSON content type. The separate Node browser worker also requires a private token and rejects browser-origin requests. Browser contexts are isolated per run and closed when that run ends.

The viewer reads local artifacts without a user login. Do not expose it through a tunnel or public reverse proxy. Other processes running as your user are trusted. The viewer escapes raw Markdown HTML and limits file serving to allowed files inside the relevant Atlas or screenshot directory.

Browser screenshot destinations are run-scoped. Generated directories reject symlink/junction components; screenshots are written from captured bytes with exclusive creation, so existing files or links cannot be overwritten. Use a new screenshot name for each capture. Directory cleanup uses guarded operations with expected names and file inventories. These protections reduce accidents; they are not a security boundary against a provider agent with unrestricted shell access or another local process changing files concurrently.

## What can leave the machine

The app under test makes its own network requests. When using a provider, project files, prompts, page content, screenshots, and observations can be sent to that provider as the agent works. Provider authentication, billing, retention, and policy settings are managed by the provider CLI and account. Scripted demo and test agents make no LLM calls.

## Stored artifacts

Reports and screenshots may contain application data. Transcripts can include commands and tool output. The harness redacts its ephemeral browser API token from saved CLI transcripts and QA prompts/output; it does not identify or scrub all application credentials or personal data.

Never publish a run folder blindly. Inspect its JSON, Markdown, screenshots, and transcripts. `.atlas-qa/` is ignored automatically. Published `docs/ui-atlas/` is intentionally shareable only after you review it. Do not use real accounts or sensitive data in the fictional demo.

Report security issues using the instructions in [SECURITY.md](../SECURITY.md).

## Process lifetime

POSIX provider launches own process groups; timeout/cancellation cleans up and verifies the group even after a graceful root exit. Windows uses bounded tree termination. Cleanup failures make provider results inconclusive. This is cooperative lifecycle management: a program that deliberately starts a detached OS session can escape a process group. [Linux live-provider runs](evals.md#live-provider-runs) exercise normal completion; they do not establish adversarial containment. Native Windows/macOS behavior still needs separate validation.
