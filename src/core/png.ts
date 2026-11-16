import { readFileSync, statSync } from 'node:fs';
import { PNG } from 'pngjs';

/** Decode bounded PNGs, checking chunk CRCs and the complete pixel stream. */
export function validPngFile(path: string): boolean {
  try {
    const size = statSync(path).size;
    if (size < 45 || size > 32 * 1024 * 1024) return false;
    const bytes = readFileSync(path);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return false;
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > 16_384 || height > 16_384 || width * height > 16_777_216) return false;
    const image = PNG.sync.read(bytes, { checkCRC: true });
    return image.width === width && image.height === height && image.data.length === width * height * 4;
  } catch { return false; }
}
