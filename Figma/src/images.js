import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function readImage(filePath) {
  if (!isAbsolute(filePath)) throw new Error('Image filePath must be an absolute local path.');
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Image path must refer to a regular file.');
    if (stat.size > 8 * 1024 * 1024) throw new Error('Image exceeds 8 MiB.');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, 8 * 1024 * 1024 + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error('Image file changed while reading. Try again.');
    const bytes = buffer.subarray(0, size);
    const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpeg) throw new Error('Only PNG and JPEG image files are supported.');
    return bytes.toString('base64');
  } finally { await file.close(); }
}
