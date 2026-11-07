import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, validateCommand } from '../src/server.js';
import { mockFigma } from './helpers/figma.js';

async function session(t) {
  const figma = mockFigma(() => {});
  const context = vm.createContext({ figma, __html__: '' });
  vm.runInContext(readFileSync(new URL('../plugin/code.js', import.meta.url), 'utf8'), context);
  const server = createServer({ request: (command, args) => context.execute(command, validateCommand(command, args)) });
  const client = new Client({ name: 'design-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name, args) => client.callTool({ name: 'figma_' + name, arguments: args });
  const data = async (name, args) => {
    const response = await call(name, args);
    assert.equal(response.isError, undefined, response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  return { figma, call, data, context };
}

test('gradient, stacking and reusable styles preserve validation before mutation', async t => {
  const { figma, data, call } = await session(t);
  const a = figma.createRectangle(), b = figma.createRectangle();
  const gradient = await data('set_gradient', { nodeId: a.id, angle: 90, stops: [{ position: 0, color: '#000000' }, { position: 1, color: '#FFFFFF' }] });
  assert.equal(gradient.fills[0].type, 'GRADIENT_LINEAR');
  assert.equal(gradient.fills[0].gradientStops[1].color.r, 1);
  const old = JSON.stringify(a.fills);
  assert.equal((await call('set_gradient', { nodeId: a.id, stops: [{ position: 1, color: '#000000' }, { position: 0, color: '#FFFFFF' }] })).isError, true);
  assert.equal(JSON.stringify(a.fills), old);
  assert.equal((await data('reorder_node', { nodeId: a.id, position: 'FRONT' })).index, 1);
  assert.equal((await data('reorder_node', { nodeId: a.id, position: 'BACKWARD' })).index, 0);
  assert.equal(figma.currentPage.children[1].id, b.id);
  const paint = await data('create_paint_style', { name: 'Brand', color: '#123456' });
  const textStyle = await data('create_text_style', { name: 'Body', fontSize: 16 });
  const text = figma.createText();
  await data('apply_styles', { nodeId: text.id, fillStyleId: paint.id, textStyleId: textStyle.id });
  assert.equal(text.textStyleId, textStyle.id);
  assert.equal((await call('apply_styles', { nodeId: a.id, fillStyleId: textStyle.id })).isError, true);
  assert.equal(a.fillStyleId, undefined);
  assert.equal((await call('create_text_style', { name: 'Missing', fontFamily: 'Missing' })).isError, true);
});

test('collections and variables support modes, binding, type checks and failed-creation cleanup', async t => {
  const { figma, data, call } = await session(t);
  const collection = await data('create_variable_collection', { name: 'Theme', modes: ['Light', 'Dark'] });
  assert.equal(collection.modes[1].name, 'Dark');
  const light = collection.modes[0].modeId, dark = collection.modes[1].modeId;
  const color = await data('create_variable', { name: 'Brand', collectionId: collection.id, type: 'COLOR', values: [{ modeId: light, value: { r: 1, g: 0, b: 0 } }, { modeId: dark, value: { r: 0, g: 0, b: 1 } }] });
  await data('set_variable', { variableId: color.id, modeId: dark, value: { r: 0, g: 1, b: 0 } });
  const node = figma.createRectangle(); node.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
  await data('bind_variable', { nodeId: node.id, variableId: color.id, field: 'fill' });
  assert.equal(node.fills[0].boundVariables.color.id, color.id);
  await data('set_variable_mode', { nodeId: node.id, collectionId: collection.id, modeId: dark });
  assert.equal(node.explicitVariableModes[collection.id], dark);
  const spacing = await data('create_variable', { name: 'Spacing', collectionId: collection.id, type: 'FLOAT', values: [{ modeId: light, value: 16 }] });
  await data('bind_variable', { nodeId: node.id, variableId: spacing.id, field: 'cornerRadius' });
  assert.equal(node.boundVariables.cornerRadius.id, spacing.id);
  assert.equal((await call('set_variable', { variableId: spacing.id, modeId: light, value: 'bad' })).isError, true);
  assert.equal((await call('set_variable', { variableId: spacing.id, modeId: 'unknown', value: 8 })).isError, true);
  assert.equal((await call('bind_variable', { nodeId: node.id, variableId: color.id, field: 'opacity' })).isError, true);
  const before = await data('get_variables', {});
  assert.equal((await call('create_variable', { name: 'Invalid', collectionId: collection.id, type: 'BOOLEAN', values: [{ modeId: light, value: 1 }] })).isError, true);
  assert.equal((await call('create_variable_collection', { name: 'Limited', modes: ['Default', 'Restricted'] })).isError, true);
  const after = await data('get_variables', {});
  assert.equal(after.total, before.total); assert.equal(after.collectionTotal, before.collectionTotal);
});

test('responsive sizing, variants and instance property changes reject incompatible edits', async t => {
  const { figma, data, call } = await session(t);
  const parent = figma.createFrame(), child = figma.createRectangle(); parent.appendChild(child);
  assert.equal((await call('set_responsive', { nodeId: child.id, properties: { layoutSizingHorizontal: 'FILL' } })).isError, true);
  assert.equal(child.layoutSizingHorizontal, 'FIXED');
  parent.layoutMode = 'VERTICAL';
  await data('set_responsive', { nodeId: child.id, properties: { layoutSizingHorizontal: 'FILL', minWidth: 100, maxWidth: 500 } });
  assert.equal(child.layoutSizingHorizontal, 'FILL');
  assert.equal((await call('set_responsive', { nodeId: child.id, properties: { minWidth: 600 } })).isError, true);
  const first = figma.createComponentFromNode(figma.createFrame()), second = figma.createComponentFromNode(figma.createFrame());
  first.name = 'State=Default'; second.name = 'State=Hover';
  const instance = first.createInstance();
  assert.equal((await data('get_component_properties', { nodeId: instance.id })).properties.Label.type, 'TEXT');
  await data('set_instance_properties', { nodeId: instance.id, properties: { Label: '送信', Enabled: false } });
  assert.equal(instance.componentProperties.Label.value, '送信');
  assert.equal((await call('set_instance_properties', { nodeId: instance.id, properties: { Label: true } })).isError, true);
  assert.equal(instance.componentProperties.Label.value, '送信');
  assert.equal((await data('combine_variants', { nodeIds: [first.id, second.id], name: 'Button' })).type, 'COMPONENT_SET');
  assert.equal((await call('combine_variants', { nodeIds: [parent.id, child.id], name: 'Bad' })).isError, true);
});

test('batch updates prevalidate capabilities and report partial failures', async t => {
  const { figma, data, call } = await session(t);
  const rectangle = figma.createRectangle(), text = figma.createText();
  assert.equal((await call('batch_update', { nodeIds: [rectangle.id, text.id], properties: { characters: 'Bad' } })).isError, true);
  assert.equal(text.characters, '');
  const good = await data('batch_update', { nodeIds: [rectangle.id, text.id], properties: { name: 'Shared', fill: '#336699' } });
  assert.equal(good.updated.length, 2);
  text.fontName = { family: 'Missing', style: 'Regular' };
  const partial = await data('batch_update', { nodeIds: [rectangle.id, text.id], properties: { fill: '#FFFFFF' } });
  assert.equal(partial.partial, true); assert.equal(partial.updated[0], rectangle.id); assert.equal(partial.failed[0].id, text.id);
});

test('read-only audit finds contrast, clipped text and spacing issues, reports skipped checks and bounds work', async t => {
  const { figma, data, context } = await session(t);
  const frame = figma.createFrame(); frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]; frame.clipsContent = true; frame.paddingTop = 7;
  const text = figma.createText(); text.fills = [{ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.8 } }]; text.x = 80; text.fontSize = 10; frame.appendChild(text);
  const before = figma.commits;
  const audit = await data('audit_design', { rootId: frame.id });
  const codes = audit.issues.map(issue => issue.code);
  assert.ok(codes.includes('LOW_CONTRAST')); assert.ok(codes.includes('TEXT_CLIPPED_BOUNDS')); assert.ok(codes.includes('SPACING_GRID')); assert.ok(codes.includes('SMALL_TEXT'));
  assert.equal(figma.commits, before);
  text.fills = [{ type: 'GRADIENT_LINEAR' }];
  assert.equal((await data('audit_design', { rootId: frame.id })).skippedContrast, 1);
  assert.equal((await data('audit_design', { rootId: frame.id, maxNodes: 1 })).truncated, true);
  assert.equal(context.luminance({ r: 0, g: 0, b: 0 }), 0);
  assert.equal(context.luminance({ r: 1, g: 1, b: 1 }), 1);
});
