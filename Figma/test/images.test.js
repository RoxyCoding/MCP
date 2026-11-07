import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readImage } from '../src/images.js';

test('local image reader limits size and rejects non-image content before encoding', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-image-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(readImage('relative.png'), /absolute/);
  await assert.rejects(readImage(directory), /regular file/);
  const file = join(directory, 'image.png');
  await writeFile(file, 'not an image');
  await assert.rejects(readImage(file), /Only PNG and JPEG/);
  await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(readImage(file), /8 MiB/);
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 0]);
  await writeFile(file, jpeg);
  assert.equal(await readImage(file), jpeg.toString('base64'));
});
