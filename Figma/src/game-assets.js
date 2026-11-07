import { mkdir, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export async function saveGameData(data, filename, outputDirectory = fileURLToPath(new URL('../exports/', import.meta.url))) {
  if (!isAbsolute(outputDirectory) || !['localization.json', 'ui-spec.json'].includes(filename)) throw new Error('Invalid game JSON output path.');
  const text = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Game JSON exceeds 8 MiB.');
  await mkdir(outputDirectory, { recursive: true });
  const folder = resolve(outputDirectory, 'game-ui-' + randomUUID());
  if (dirname(folder) !== resolve(outputDirectory)) throw new Error('Output folder escaped its directory.');
  await mkdir(folder);
  try { const filePath = join(folder, filename); await writeFile(filePath, text, { flag: 'wx' }); return { directory: folder, filePath }; }
  catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
}

export async function saveGameAssets(exported, outputDirectory = fileURLToPath(new URL('../exports/', import.meta.url))) {
  if (!isAbsolute(outputDirectory)) throw new Error('outputDirectory must be absolute.');
  if (!exported || !Array.isArray(exported.images) || !exported.images.length || exported.images.length > 8) throw new Error('Invalid game export response.');
  const files = [], names = new Set();
  let size = 0;
  for (const image of exported.images) {
    if (!image || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}@[0-9.]+x\.png$/.test(image.filename) || names.has(image.filename) || typeof image.data !== 'string' || image.data.length > 11184812) throw new Error('Invalid exported image.');
    names.add(image.filename);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error('Invalid image encoding.');
    const bytes = Buffer.from(image.data, 'base64'); size += bytes.length;
    if (size > 8 * 1024 * 1024) throw new Error('Export exceeds 8 MiB total.');
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Exported file is not a PNG.');
    if (bytes.readUInt32BE(16) !== image.pixelWidth || bytes.readUInt32BE(20) !== image.pixelHeight) throw new Error('PNG dimensions do not match export metadata.');
    files.push({ image, bytes });
  }
  await mkdir(outputDirectory, { recursive: true });
  const folder = resolve(outputDirectory, 'game-ui-' + randomUUID());
  if (dirname(folder) !== resolve(outputDirectory)) throw new Error('Export folder escaped its output directory.');
  await mkdir(folder);
  try {
    for (const file of files) await writeFile(join(folder, file.image.filename), file.bytes, { flag: 'wx' });
    const manifest = { version: 1, origin: 'top-left', engine: 'generic', assets: files.map(({ image: { data, ...metadata } }) => metadata) };
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    return { directory: folder, manifestPath: join(folder, 'manifest.json'), files: files.map(({ image }) => join(folder, image.filename)) };
  } catch (error) {
    // Only remove the unique folder created by this export; existing outputs are never overwritten.
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
