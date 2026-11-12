// End-to-end tour without an LLM: starts Acme Notes, builds its UI Atlas with
// the scripted atlas agent, then runs a scripted QA pass that finds the
// deliberate settings bug. Uses real Chromium (run `bun run browsers:install`).
//
//   bun run demo:tour
//   bun run serve examples/demo-app      # then open the printed URL

import { join } from 'node:path';
import { buildAtlas } from '../../src/atlas/atlas-runner';
import { WorkerBrowserDriver } from '../../src/browser/worker-driver';
import { ScriptedProvider } from '../../src/providers/scripted';
import { runQa } from '../../src/qa/qa-runner';
import scriptedAtlas from './agents/scripted-atlas';
import scriptedQa from './agents/scripted-qa';
import { startDemoServer } from './server';

const projectDir = import.meta.dir;
const app = startDemoServer(0);
const appUrl = `http://127.0.0.1:${app.port}`;
const driver = new WorkerBrowserDriver();
const log = (line: string) => console.log(line);

try {
  log(`Acme Notes running at ${appUrl}`);
  log('\n1) Building the UI Atlas with the scripted atlas agent...');
  const atlas = await buildAtlas({
    projectDir,
    url: appUrl,
    provider: new ScriptedProvider(scriptedAtlas, 'script:scripted-atlas'),
    driver,
    onPhase: phase => log(`   phase: ${phase}`),
  });
  log(`   Atlas ${atlas.status}: ${atlas.surfaceCount} surfaces, ${atlas.entityCount} entities -> ${join(projectDir, 'docs', 'ui-atlas')}`);
  for (const error of atlas.validationErrors ?? []) log(`   ! ${error}`);

  log('\n2) Running a scripted QA pass against the settings page...');
  const qa = await runQa({
    projectDir,
    url: `${appUrl}/settings`,
    goal: 'Saving settings shows a confirmation message.',
    changeDescription: 'Refactored the settings save handler.',
    provider: new ScriptedProvider(scriptedQa, 'script:scripted-qa'),
    driver,
    onProgress: event => { if (event.type === 'text') log(`   ${event.text}`); },
  });
  log(`   ${qa.run.verdict?.toUpperCase()}: ${qa.run.summary}`);
  for (const finding of qa.run.findings ?? []) log(`   - [${finding.severity}] ${finding.title}`);
  log(`   Report: ${qa.reportPath}`);

  log('\nNext: bun run serve examples/demo-app   (browse the atlas and the QA run)');
  log('      bun run atlas query -p examples/demo-app "where are tags shown?"');
} finally {
  await driver.close();
  app.stop(true);
}
