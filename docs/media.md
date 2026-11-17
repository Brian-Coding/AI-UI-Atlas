# Reproduce the demo recording

These are recordings of the running application on Linux with fictional Acme Notes data. No generated mockups, live provider output, personal projects or accounts are used.

```bash
bun install --frozen-lockfile
bun run browsers:install
bun run media
```

Node.js 20+ and ffmpeg on PATH are required for recording. Chromium uses the Playwright install above. The script builds a real five-surface Atlas in a temporary project, opens the real viewer, runs scripted QA while recording, and displays the failing verdict and evidence. The initial map build occurs before video capture; the QA run occurs during capture. Bottom captions are recording annotations, not product controls. Temporary state and browser processes are removed after completion.

Outputs: [GIF](images/atlas-demo.gif), [MP4](images/atlas-demo.mp4), [PNG](images/atlas-demo.png). Source: [orchestrator](../scripts/media.ts), [recorder](../scripts/record-media.mjs).

Recordings depend on browser timing, so frame timings and generated run IDs may vary. The committed GIF stays below 5 MB. Inspect every frame before sharing recordings made against any other data. The scripted demonstrations establish workflow plumbing, not live Claude/Codex performance or compatibility.
