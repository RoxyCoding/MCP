import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { session } from './helpers/session.js';
import { png } from './helpers/png.js';

async function temporary(t) { const directory = await mkdtemp(join(tmpdir(), 'game-ui-expansion-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }

test('localization preview measures long text and preserves source; applies supplied text and exports conflicts', async t => {
  const { figma, data, call } = await session(t), directory = await temporary(t);
  const frame = figma.createFrame(); frame.resize(400, 300); frame.name = 'Menu';
  const text = figma.createText(); frame.appendChild(text); text.characters = 'Play'; text.resize(80, 16);
  await data('set_localization_key', { nodeId: text.id, key: 'menu.play' });
  const preview = await data('preview_localization', { rootId: frame.id, locale: 'de', translations: { 'menu.play': 'This translated button label is much longer than the original.' } });
  assert.equal(text.characters, 'Play'); assert.equal(preview.updated.length, 1); assert.equal(preview.overflow.length, 1);
  const applied = await data('apply_localization', { rootId: frame.id, locale: 'ja', translations: { 'menu.play': '開始' } });
  assert.equal(applied.updated[0], text.id); assert.equal(text.characters, '開始');
  const duplicate = figma.createText(); frame.appendChild(duplicate); duplicate.characters = 'Different';
  await data('set_localization_key', { nodeId: duplicate.id, key: 'menu.play' });
  const output = await data('export_localization', { rootId: frame.id, outputDirectory: directory });
  const json = JSON.parse(await readFile(output.filePath, 'utf8'));
  assert.equal(json.strings['menu.play'], '開始'); assert.equal(json.conflicts.length, 1);
  const before = figma.currentPage.children.length;
  assert.equal((await call('preview_localization', { rootId: frame.id, locale: 'badfont', fontFamily: 'Missing', translations: { 'menu.play': 'Test' } })).isError, true);
  assert.equal(figma.currentPage.children.length, before);
  assert.equal((await data('apply_localization', { rootId: frame.id, locale: 'en', translations: {} })).missing.length, 2);
});

test('resolution clones remap safe-area and anchor IDs, leave the source intact, and clean failed previews', async t => {
  const { figma, data, call } = await session(t);
  const source = await data('create_game_screen', { name: 'HUD', width: 800, height: 600, insets: { left: 20, right: 20, top: 20, bottom: 20 } });
  const safe = await figma.getNodeByIdAsync(source.safeArea.id), child = figma.createRectangle(); child.resize(100, 40); safe.appendChild(child);
  await data('set_game_anchor', { nodeId: child.id, anchor: 'BOTTOM_RIGHT', marginX: 10, marginY: 10 });
  const originalX = child.x;
  const preview = await data('preview_resolutions', { rootId: source.screen.id, views: [{ name: 'Wide', width: 1200, height: 600 }, { name: 'Portrait', width: 400, height: 800 }] });
  assert.equal(preview.previews.length, 2); assert.equal(child.x, originalX);
  const copy = await figma.getNodeByIdAsync(preview.previews[0].nodeId), metadata = JSON.parse(copy.getPluginData('game-ui'));
  assert.notEqual(metadata.screen.safeAreaId, safe.id);
  const copySafe = await figma.getNodeByIdAsync(metadata.screen.safeAreaId);
  assert.equal(copySafe.width, 1160); assert.equal(copySafe.children[0].x, 1050);
  assert.equal(JSON.parse(copySafe.children[0].getPluginData('game-ui')).anchor.parentId, copySafe.id);
  const before = figma.currentPage.children.length;
  assert.equal((await call('preview_resolutions', { rootId: source.screen.id, views: [{ name: 'Valid', width: 400, height: 400 }, { name: 'Too small', width: 64, height: 64 }], maxNodes: 1 })).isError, true);
  assert.equal(figma.currentPage.children.length, before);
});

test('state sheet creates distinct labeled clones and cleans up invalid variant requests', async t => {
  const { figma, data, call } = await session(t);
  const button = await data('create_game_button', { name: 'Play', label: 'Play' });
  const instance = await data('create_instance', { componentId: button.variants[0].id });
  const original = await figma.getNodeByIdAsync(instance.id);
  const sheet = await data('create_state_sheet', { nodeId: original.id, name: 'Button states' });
  assert.equal(sheet.states.length, 4);
  assert.equal((await figma.getNodeByIdAsync(sheet.states[1].nodeId)).componentProperties.State.value, 'Focused');
  assert.equal(original.componentProperties.State.value, 'Default');
  const before = figma.currentPage.children.length;
  assert.equal((await call('create_state_sheet', { nodeId: original.id, name: 'Bad states', states: ['Default', 'Unknown'] })).isError, true);
  assert.equal(figma.currentPage.children.length, before);
});

test('device prompts replace only glyphs and inventory updates labels, selection and focus default', async t => {
  const { figma, data, call } = await session(t);
  const prompt = await data('create_input_prompt', { name: 'Confirm', action: 'CONFIRM', label: '決定' });
  const label = await figma.getNodeByIdAsync(prompt.labelId);
  const switched = await data('set_input_device', { nodeId: prompt.nodeId, device: 'PLAYSTATION' });
  assert.notEqual(switched.glyphId, prompt.glyphId); assert.equal(label.characters, '決定');
  assert.equal(await figma.getNodeByIdAsync(prompt.glyphId), undefined);
  const inventory = await data('create_inventory', { name: 'Items', rows: 2, columns: 3 });
  assert.equal(inventory.slots.length, 6);
  const item = await data('set_inventory_item', { nodeId: inventory.nodeId, index: 4, itemName: 'Potion', quantity: 3 });
  assert.equal(item.quantity, 3);
  const selection = await data('select_inventory_slot', { nodeId: inventory.nodeId, index: 4 });
  const root = await figma.getNodeByIdAsync(inventory.nodeId);
  assert.equal(JSON.parse(root.getPluginData('game-ui')).focus.defaultNodeId, selection.slotId);
  assert.equal((await figma.getNodeByIdAsync(selection.slotId)).strokeWeight, 3);
  assert.equal((await data('set_inventory_item', { nodeId: inventory.nodeId, index: 4, itemName: '' })).quantity, 0);
  assert.equal((await call('select_inventory_slot', { nodeId: inventory.nodeId, index: 6 })).isError, true);
  const before = figma.currentPage.children.length;
  assert.equal((await call('create_inventory', { name: 'Oversize', rows: 20, columns: 20 })).isError, true);
  assert.equal(figma.currentPage.children.length, before);
});

test('radial cooldown sweeps and edge-aware tooltips update without runtime assumptions', async t => {
  const { figma, data, call } = await session(t);
  const cooldown = await data('create_cooldown', { name: 'Skill', value: 0.5, innerRadius: 0.5, seconds: 4.2 });
  const overlay = await figma.getNodeByIdAsync(cooldown.overlayId);
  assert.ok(Math.abs(overlay.arcData.endingAngle - overlay.arcData.startingAngle - Math.PI) < 0.00001);
  assert.equal((await figma.getNodeByIdAsync(cooldown.labelId)).characters, '5');
  assert.equal((await data('set_cooldown', { nodeId: cooldown.nodeId, value: 0, seconds: 0 })).visible, false);
  const screen = figma.createFrame(); screen.resize(600, 400);
  const target = figma.createRectangle(); screen.appendChild(target); target.resize(80, 40); target.x = 260; target.y = 0;
  const tip = await data('create_tooltip', { parentId: screen.id, name: 'Tip', targetId: target.id, text: 'Details', width: 200 });
  assert.equal(tip.placement, 'BELOW'); assert.ok(tip.y >= 48);
  target.y = 350;
  const moved = await data('position_tooltip', { nodeId: tip.nodeId, targetId: target.id, preferred: 'BELOW' });
  assert.equal(moved.placement, 'ABOVE');
  assert.equal((await call('create_tooltip', { parentId: screen.id, name: 'Bad', targetId: cooldown.nodeId, text: 'Not in screen' })).isError, true);
});

test('atlas packing produces valid PNG plus nonoverlapping coordinates and removes temporary clones on success or failure', async t => {
  const { figma, data, call } = await session(t), directory = await temporary(t);
  const a = figma.createRectangle(), b = figma.createRectangle(); a.resize(32, 16); b.resize(16, 24);
  await data('set_nine_slice', { nodeId: a.id, borders: { left: 4, right: 4, top: 4, bottom: 4 } });
  const before = figma.currentPage.children.length;
  const exported = await data('export_game_atlas', { assets: [{ nodeId: a.id, name: 'panel' }, { nodeId: b.id, name: 'icon' }], maxWidth: 128, scale: 2, outputDirectory: directory });
  const manifest = JSON.parse(await readFile(exported.manifestPath, 'utf8')), atlas = manifest.assets[0];
  assert.equal(atlas.kind, 'atlas'); assert.equal(atlas.sprites.length, 2);
  assert.equal(atlas.sprites.find(sprite => sprite.name === 'panel').nineSlice.borders.left, 8);
  const [first, second] = atlas.sprites;
  assert.ok(first.x + first.width <= second.x || second.x + second.width <= first.x || first.y + first.height <= second.y || second.y + second.height <= first.y);
  assert.equal((await readFile(exported.files[0])).readUInt32BE(16), atlas.pixelWidth);
  assert.equal(figma.currentPage.children.length, before);
  assert.equal((await call('export_game_atlas', { assets: [{ nodeId: a.id, name: 'too_big' }], maxWidth: 64, scale: 4, outputDirectory: directory })).isError, true);
  assert.equal(figma.currentPage.children.length, before);
  const factory = figma.createFrame;
  figma.createFrame = () => { const node = factory(); node.exportAsync = async () => { throw new Error('Export failed'); }; return node; };
  assert.equal((await call('export_game_atlas', { assets: [{ nodeId: a.id, name: 'failure' }], outputDirectory: directory })).isError, true);
  assert.equal(figma.currentPage.children.length, before);
});

test('focus audit detects broken/unreachable controls and UI spec exports bounded layout metadata', async t => {
  const { figma, data } = await session(t), directory = await temporary(t);
  const inventory = await data('create_inventory', { name: 'Grid', rows: 1, columns: 3 });
  const root = await figma.getNodeByIdAsync(inventory.nodeId);
  assert.equal((await data('audit_game_focus', { rootId: root.id })).reachable, 3);
  const metadata = JSON.parse(root.getPluginData('game-ui'));
  metadata.focus.links[inventory.slots[0].nodeId].right = '99:999'; root.setPluginData('game-ui', JSON.stringify(metadata));
  const audit = await data('audit_game_focus', { rootId: root.id });
  assert.ok(audit.issues.some(issue => issue.code === 'INVALID_EDGE')); assert.ok(audit.issues.some(issue => issue.code === 'UNREACHABLE_CONTROL'));
  const spec = await data('export_ui_spec', { rootId: root.id, outputDirectory: directory });
  const json = JSON.parse(await readFile(spec.filePath, 'utf8'));
  assert.equal(json.rootId, root.id); assert.equal(json.nodes[0].game.inventory.columns, 3); assert.equal(json.engine, 'generic');
});
