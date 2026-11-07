import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { session } from './helpers/session.js';
import { png } from './helpers/png.js';
import { saveGameAssets } from '../src/game-assets.js';

test('game screen safe area and anchors enforce fitting and preserve metadata', async t => {
  const { figma, call, data } = await session(t);
  const screen = await data('create_game_screen', { name: 'HUD', width: 1280, height: 720, insets: { left: 40, right: 40, top: 20, bottom: 20 } });
  assert.equal(screen.safeArea.width, 1200); assert.equal(screen.safeArea.height, 680);
  const root = await figma.getNodeByIdAsync(screen.screen.id), safe = await figma.getNodeByIdAsync(screen.safeArea.id);
  assert.equal(JSON.parse(root.getPluginData('game-ui')).screen.safeAreaId, safe.id);
  const node = figma.createRectangle(); node.resize(100, 40); safe.appendChild(node);
  await data('set_game_anchor', { nodeId: node.id, anchor: 'BOTTOM_RIGHT', marginX: 16, marginY: 12 });
  assert.equal(node.x, 1084); assert.equal(node.y, 628); assert.equal(node.constraints.horizontal, 'MAX');
  await data('set_game_anchor', { nodeId: node.id, anchor: 'STRETCH', marginX: 8, marginY: 8 });
  assert.equal(node.width, 1184); assert.equal(node.height, 664);
  const before = node.width;
  assert.equal((await call('set_game_anchor', { nodeId: node.id, anchor: 'STRETCH', marginX: 1000 })).isError, true);
  assert.equal(node.width, before);
  const pageCount = figma.currentPage.children.length;
  assert.equal((await call('create_game_screen', { name: 'Invalid', width: 100, height: 100 })).isError, true);
  assert.equal(figma.currentPage.children.length, pageCount);
});

test('focus graph gives directional links without wrapping and validates its default target', async t => {
  const { figma, data, call } = await session(t);
  const parent = figma.createFrame(), controls = [];
  for (const [x, y] of [[0, 0], [200, 0], [0, 100], [200, 100]]) {
    const node = figma.createRectangle(); node.resize(100, 40); node.x = x; node.y = y; parent.appendChild(node); controls.push(node);
  }
  const result = await data('build_game_focus', { nodeIds: controls.map(node => node.id) });
  assert.equal(result.focus.links[controls[0].id].right, controls[1].id);
  assert.equal(result.focus.links[controls[0].id].down, controls[2].id);
  assert.equal(result.focus.links[controls[0].id].left, null);
  assert.equal(JSON.parse(parent.getPluginData('game-ui')).focus.defaultNodeId, controls[0].id);
  assert.equal((await call('build_game_focus', { nodeIds: controls.map(node => node.id), defaultNodeId: parent.id })).isError, true);
  controls[0].visible = false;
  assert.equal((await call('build_game_focus', { nodeIds: controls.map(node => node.id) })).isError, true);
});

test('game button state variants and HUD bars handle state changes and zero values', async t => {
  const { figma, data, call } = await session(t);
  const button = await data('create_game_button', { name: 'Play', label: '開始' });
  assert.equal(button.variants.length, 4);
  const focused = await figma.getNodeByIdAsync(button.variants[1].id);
  assert.equal(focused.name, 'State=Focused'); assert.equal(focused.strokeWeight, 3);
  const disabled = await figma.getNodeByIdAsync(button.variants[3].id);
  assert.equal(disabled.opacity, 0.4);
  const before = figma.currentPage.children.length;
  assert.equal((await call('create_game_button', { name: 'Missing font', label: 'Bad', fontFamily: 'Missing' })).isError, true);
  assert.equal(figma.currentPage.children.length, before);
  const bar = await data('create_hud_bar', { name: 'HP', width: 200, height: 20, value: 0.75 });
  assert.equal((await figma.getNodeByIdAsync(bar.fillId)).width, 150);
  assert.equal((await data('set_hud_value', { nodeId: bar.node.id, value: 0 })).visible, false);
  const frame = await figma.getNodeByIdAsync(bar.node.id); frame.resize(400, 20);
  assert.equal((await data('set_hud_value', { nodeId: frame.id, value: 0.5 })).width, 200);
  assert.equal((await call('set_hud_value', { nodeId: frame.id, value: 2 })).isError, true);
  const vertical = await data('create_hud_bar', { name: 'MP', width: 20, height: 200, value: 0.25, direction: 'VERTICAL' });
  const fill = await figma.getNodeByIdAsync(vertical.fillId);
  assert.equal(fill.height, 50); assert.equal(fill.y, 150);
  assert.equal((await call('set_hud_value', { nodeId: focused.id, value: 0.5 })).isError, true);
});

test('9-slice borders scale with real PNG dimensions and export writes unique local packages', async t => {
  const { figma, data, call } = await session(t);
  const directory = await mkdtemp(join(tmpdir(), 'game-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const node = figma.createRectangle(); node.resize(120, 60);
  node.exportAsync = async settings => {
    assert.equal(settings.useAbsoluteBounds, true); assert.equal(settings.colorProfile, 'SRGB');
    return new Uint8Array(png(Math.ceil(node.width * settings.constraint.value), Math.ceil(node.height * settings.constraint.value)));
  };
  await data('set_nine_slice', { nodeId: node.id, borders: { left: 10, right: 10, top: 8, bottom: 8 } });
  assert.equal((await call('set_nine_slice', { nodeId: node.id, borders: { left: 60, right: 60, top: 8, bottom: 8 } })).isError, true);
  const args = { assets: [{ nodeId: node.id, name: 'panel' }], scales: [1, 2], outputDirectory: directory };
  const exported = await data('export_game_assets', args);
  const manifest = JSON.parse(await readFile(exported.manifestPath, 'utf8'));
  assert.equal(manifest.assets[1].pixelWidth, 240); assert.equal(manifest.assets[1].nineSlice.borders.left, 20);
  assert.equal((await readFile(exported.files[1])).readUInt32BE(16), 240);
  const again = await data('export_game_assets', args);
  assert.notEqual(again.directory, exported.directory);
  assert.equal((await readdir(exported.directory)).length, 3);
  assert.equal((await call('export_game_assets', { assets: [{ nodeId: node.id, name: '../escape' }] })).isError, true);
  node.resize(16, 16);
  assert.equal((await call('export_game_assets', args)).isError, true, 'Stale 9-slice is revalidated after resize');
});

test('export writer rejects path traversal, duplicate files, corrupt PNG and metadata mismatch before writing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'game-export-validation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = { filename: 'panel@1x.png', pixelWidth: 4, pixelHeight: 4, data: png(4, 4).toString('base64') };
  await assert.rejects(saveGameAssets({ images: [{ ...image, filename: '../outside.png' }] }, directory), /Invalid exported image/);
  await assert.rejects(saveGameAssets({ images: [image, image] }, directory), /Invalid exported image/);
  await assert.rejects(saveGameAssets({ images: [{ ...image, data: Buffer.from('not PNG').toString('base64') }] }, directory), /not a PNG/);
  await assert.rejects(saveGameAssets({ images: [{ ...image, pixelWidth: 5 }] }, directory), /dimensions/);
  assert.equal((await readdir(directory)).length, 0);
});
