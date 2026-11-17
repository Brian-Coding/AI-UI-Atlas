import assert from 'node:assert/strict';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
const [origin, root] = process.argv.slice(2);
const output = resolve(import.meta.dirname, '../docs/images');
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: join(root, 'video'), size: { width: 1280, height: 800 } } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // Recording annotation is explicitly labeled; application results are untouched.
  const caption = async text => page.evaluate(text => {
    let el = document.getElementById('recording-caption');
    if (!el) { el = document.createElement('div'); el.id = 'recording-caption'; document.body.append(el); }
    el.style.cssText = 'position:fixed;bottom:12px;left:24px;z-index:9999;background:#182430;color:#fff;padding:10px 16px;border-radius:6px;font:14px system-ui;box-shadow:0 2px 10px #0003';
    el.textContent = text;
  }, text);
  await page.goto(origin);
  await page.locator('.card .num').first().filter({ hasText: '5' }).waitFor();
  await caption('Scripted demo · 1. Map: five surfaces captured in real Chromium');
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Surfaces', exact: true }).click();
  await page.getByRole('textbox', { name: 'Filter records' }).fill('settings');
  await page.waitForTimeout(2000);
  await caption('Scripted demo · 2. Run: save settings through the browser API');
  await writeFile(join(root, 'start'), 'start');
  let done = false;
  for (let i = 0; i < 300; i++) { try { await access(join(root, 'done')); done = true; break; } catch {} await page.waitForTimeout(100); }
  assert.ok(done, 'QA did not finish');
  await page.getByRole('button', { name: 'QA runs', exact: true }).click();
  await page.getByRole('button', { name: 'Saving settings shows a confirmation', exact: true }).click();
  await page.getByText('Runtime errors were captured by the harness', { exact: false }).first().waitFor();
  await caption('Scripted demo · 3. FAIL: assertions plus independent runtime evidence');
  await page.waitForTimeout(3000);
  await page.locator('.gallery').evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));
  await caption('Scripted demo · Captured screenshots, console errors and HTTP 500 · No model calls');
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, 'atlas-demo.png') });
  await page.waitForTimeout(3000);
  assert.deepEqual(errors, []);
  const video = page.video(); await context.close();
  const source = await video.path();
  for (const [file, args] of [
    ['atlas-demo.mp4', ['-c:v', 'libx264', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']],
    ['atlas-demo.gif', ['-filter_complex', '[0:v]fps=8,scale=1120:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer']]
  ]) {
    const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', source, ...args, join(output, file)]);
    assert.equal(result.status, 0, result.stderr?.toString());
  }
} finally { await browser.close(); }
