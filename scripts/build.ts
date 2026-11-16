import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const result = await Bun.build({ entrypoints: ['src/viewer/index.html'], outdir: 'dist', target: 'browser', minify: true });
if (!result.success) throw new Error(result.logs.map(String).join('\n'));
const notices: string[] = [];
for (const name of ['react', 'react-dom', 'scheduler', 'marked']) {
  const root = join('node_modules', name);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const license = await readFile(join(root, 'LICENSE'), 'utf8').catch(() => readFile(join(root, 'LICENSE.md'), 'utf8'));
  notices.push(`${name} ${pkg.version}\n${license}`);
}
await mkdir('dist', { recursive: true });
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n---\n\n'));
console.log(`Built ${result.outputs.length} viewer assets with third-party notices.`);
