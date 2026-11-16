import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TINY_PNG } from '../browser/fake-driver';
import { validPngFile } from './png';

test('PNG evidence must decode: signature-only, truncated, bad CRC, and oversized dimensions fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'png-evidence-'));
  const file = join(dir, 'image.png');
  try {
    await writeFile(file, TINY_PNG);
    expect(validPngFile(file)).toBe(true);
    for (const bytes of [TINY_PNG.subarray(0, 8), TINY_PNG.subarray(0, 40), Buffer.from(TINY_PNG)]) {
      if (bytes.length === TINY_PNG.length) bytes[30] = bytes[30]! ^ 0xff;
      await writeFile(file, bytes);
      expect(validPngFile(file)).toBe(false);
    }
    const large = Buffer.from(TINY_PNG); large.writeUInt32BE(1_000_000, 16);
    await writeFile(file, large); expect(validPngFile(file)).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
