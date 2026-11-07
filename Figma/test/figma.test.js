import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/bridge.js';
import { createServer, validateCommand } from '../src/server.js';
import { createSharedBridge } from '../src/shared-bridge.js';
import { figmaGet } from '../src/rest.js';

const token = 'a'.repeat(64);
import { mockFigma } from './helpers/figma.js';
const pluginCode = readFileSync(new URL('../plugin/code.js', import.meta.url), 'utf8');

test('MCP → authenticated WebSocket → Figma plugin CRUD, selection and export', async t => {
  const bridge = await createBridge({ token, port: 0 });
  t.after(() => { elements.disconnect.onclick(); return bridge.close(); });
  const uiWindow = {};
  const figma = mockFigma(message => uiWindow.onmessage({ source: null, data: { pluginMessage: message } }));
  vm.runInNewContext(pluginCode, { figma, __html__: '', Uint8Array });
  const elements = Object.fromEntries(['port', 'token', 'status', 'connect', 'disconnect', 'hide'].map(id => [id, {}]));
  elements.port.value = String(bridge.port); elements.token.value = token;
  const uiContext = vm.createContext({ window: uiWindow, document: { getElementById: id => elements[id] },
    parent: { postMessage: message => figma.ui.onmessage(message.pluginMessage) }, WebSocket, setTimeout, clearTimeout });
  const html = readFileSync(new URL('../plugin/ui.html', import.meta.url), 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], uiContext);
  elements.connect.onclick();
  const socket = vm.runInContext('[...channels.values()][0].socket', uiContext);
  await once(socket, 'open');
  assert.equal((await figma.clientStorage.getAsync('connection')).port, bridge.port);
  const server = createServer(bridge);
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name, args = {}) => client.callTool({ name: 'figma_' + name, arguments: args });
  const data = result => JSON.parse(result.content[0].text);
  assert.equal((await client.listTools()).tools.length, 72);
  assert.match(client.getInstructions(), /audit_design/);
  assert.equal(data(await call('status')).connected, true);
  figma.ui.onmessage({ type: 'hide-ui' });
  assert.equal(figma.ui.hidden, true);
  assert.equal(data(await call('status')).connected, true);
  assert.equal(data(await call('get_document')).currentPage.name, 'Page 1');
  const frame = data(await call('create_node', { type: 'FRAME', properties: { name: 'Card', width: 320, layoutMode: 'VERTICAL', itemSpacing: 12, fill: '#ffffff' } }));
  const text = data(await call('create_node', { type: 'TEXT', parentId: frame.id, properties: { characters: 'こんにちは', fontSize: 24, fill: '#336699' } }));
  assert.equal(text.characters, 'こんにちは');
  const changed = data(await call('update_node', { nodeId: text.id, properties: { characters: '更新済み', x: 8 } }));
  assert.equal(changed.characters, '更新済み');
  assert.equal(changed.x, 8);
  const styled = data(await call('set_text_style', { nodeId: text.id, properties: {
    textAlignHorizontal: 'CENTER', textDecoration: 'UNDERLINE', lineHeight: { unit: 'PERCENT', value: 150 }, letterSpacing: { unit: 'PIXELS', value: 2 }
  } }));
  assert.equal(styled.textDecoration, 'UNDERLINE');
  assert.equal(styled.lineHeight.value, 150);
  assert.equal((await call('set_text_style', { nodeId: frame.id, properties: { textDecoration: 'UNDERLINE' } })).isError, true);
  assert.equal((await call('set_text_style', { nodeId: text.id, properties: { lineHeight: { unit: 'PIXELS', value: -1 } } })).isError, true);
  const appearance = data(await call('set_appearance', { nodeId: frame.id,
    stroke: { color: '#336699', width: 2 }, effects: [{ type: 'DROP_SHADOW', color: '#000000', opacity: 0.2 }, { type: 'BACKGROUND_BLUR', radius: 8 }]
  }));
  assert.equal(appearance.strokeWeight, 2);
  assert.equal(appearance.effects[0].color.a, 0.2);
  assert.equal(appearance.effects[1].type, 'BACKGROUND_BLUR');
  assert.equal(appearance.effects[1].blurType, 'NORMAL');
  assert.equal((await call('set_appearance', { nodeId: frame.id })).isError, true);
  const cleared = data(await call('set_appearance', { nodeId: frame.id, stroke: null, effects: [] }));
  assert.equal(cleared.strokes.length, 0); assert.equal(cleared.effects.length, 0);
  const selected = data(await call('select_nodes', { nodeIds: [text.id] }));
  assert.equal(selected[0].id, text.id);
  assert.equal(data(await call('get_selection'))[0].id, text.id);
  assert.equal(data(await call('get_node', { nodeId: frame.id, depth: 1 })).children[0].id, text.id);
  const image = await call('export_node', { nodeId: text.id });
  assert.equal(image.content[0].mimeType, 'image/png');
  assert.equal(data(await call('export_node', { nodeId: frame.id, format: 'SVG' })).data, '<svg/>');
  assert.equal((await call('delete_node', { nodeId: text.id, confirm: false })).isError, true);
  assert.equal((await call('update_node', { nodeId: text.id, properties: { width: -1 } })).isError, true);
  assert.equal((await call('update_node', { nodeId: text.id, properties: { arbitraryCode: 'bad' } })).isError, true);
  assert.equal((await call('update_node', { nodeId: text.id, properties: { cornerRadius: 8, name: 'Should not change' } })).isError, true);
  assert.equal(data(await call('get_node', { nodeId: text.id })).name, 'TEXT');
  assert.equal((await call('create_node', { type: 'TEXT', properties: { fontFamily: 'Missing', characters: 'bad' } })).isError, true);
  assert.equal(figma.currentPage.children.length, 1, 'Failed creation is removed');
  assert.equal((await call('delete_node', { nodeId: '0:1', confirm: true })).isError, true);
  assert.equal(data(await call('delete_node', { nodeId: text.id, confirm: true })).deleted, text.id);
  assert.equal((await call('get_node', { nodeId: text.id })).isError, true);
  assert.equal(data(await call('find_nodes', { query: 'card', types: ['FRAME'] })).nodes[0].id, frame.id);
  assert.equal(data(await call('find_nodes', { limit: 1 })).truncated, false);
  assert.equal(data(await call('get_fonts', { query: 'noto' })).fonts[0].family, 'Noto Sans JP');
  assert.equal(data(await call('get_fonts', { limit: 1 })).nextOffset, 1);
  assert.equal(data(await call('get_local_styles')).paint.styles[0].id, 'style:1');
  const newPage = data(await call('create_page', { name: 'Components' }));
  assert.equal(data(await call('get_document')).currentPage.id, '0:1', 'Creating a page does not switch pages');
  assert.equal(data(await call('set_current_page', { pageId: newPage.id })).id, newPage.id);
  assert.equal((await call('set_current_page', { pageId: frame.id })).isError, true);
  const copy = data(await call('duplicate_node', { nodeId: frame.id, parentId: newPage.id, x: 50, name: 'Copy' }));
  assert.notEqual(copy.id, frame.id);
  assert.equal(copy.x, 50);
  assert.equal(data(await call('move_node', { nodeId: copy.id, parentId: '0:1', x: 200 })).x, 200);
  assert.equal((await call('move_node', { nodeId: frame.id, parentId: frame.id })).isError, true);
  assert.equal((await call('move_node', { nodeId: '0:1', parentId: frame.id })).isError, true);
  await call('set_current_page', { pageId: '0:1' });
  const icon = data(await call('import_svg', { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>', name: 'Icon' }));
  const beforeInvalid = figma.currentPage.children.length;
  assert.equal((await call('import_svg', { svg: '<svg/>', parentId: '9:999' })).isError, true);
  assert.equal(figma.currentPage.children.length, beforeInvalid, 'Invalid parent creates no orphan SVG');
  assert.equal((await call('group_nodes', { nodeIds: [icon.id, icon.id] })).isError, true);
  const grouped = data(await call('group_nodes', { nodeIds: [copy.id, icon.id], name: 'Assets' }));
  assert.equal(grouped.type, 'GROUP');
  assert.equal(data(await call('ungroup_node', { nodeId: grouped.id })).length, 2);
  assert.equal((await call('ungroup_node', { nodeId: icon.id })).isError, true);
  const aligned = data(await call('align_nodes', { nodeIds: [copy.id, icon.id], alignment: 'RIGHT' }));
  assert.equal(aligned[0].x + aligned[0].width, aligned[1].x + aligned[1].width);
  const component = data(await call('create_component', { nodeId: icon.id }));
  assert.equal(component.type, 'COMPONENT');
  const instance = data(await call('create_instance', { componentId: component.id, x: 400 }));
  assert.equal(instance.type, 'INSTANCE');
  assert.equal(instance.x, 400);
  assert.equal((await call('create_instance', { componentId: copy.id })).isError, true);
  assert.equal(data(await call('find_nodes', { limit: 1 })).truncated, true);
  const directory = await mkdtemp(join(tmpdir(), 'figma-images-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, 'tiny.png');
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64'));
  const photo = data(await call('place_image', { filePath: imagePath, name: 'Photo' }));
  assert.equal(photo.width, 24); assert.equal(photo.height, 16);
  assert.equal(photo.fills[0].imageHash, 'test-image');
  const replaced = data(await call('place_image', { filePath: imagePath, nodeId: copy.id, scaleMode: 'FIT' }));
  assert.equal(replaced.id, copy.id); assert.equal(replaced.fills[0].scaleMode, 'FIT');
  assert.equal((await call('place_image', { filePath: imagePath, nodeId: copy.id, parentId: '0:1' })).isError, true);
  const arranged = data(await call('distribute_nodes', { nodeIds: [photo.id, copy.id, instance.id], axis: 'HORIZONTAL', gap: 20 }));
  assert.equal(arranged.nodes[1].x - arranged.nodes[0].x - arranged.nodes[0].width, 20);
  assert.equal(arranged.nodes[2].x - arranged.nodes[1].x - arranged.nodes[1].width, 20);
  const automatic = data(await call('distribute_nodes', { nodeIds: [photo.id, copy.id, instance.id], axis: 'HORIZONTAL' }));
  assert.equal(automatic.gap, 20);
  const vertical = data(await call('distribute_nodes', { nodeIds: [photo.id, copy.id, instance.id], axis: 'VERTICAL', gap: 12 }));
  assert.equal(vertical.nodes[1].y - vertical.nodes[0].y - vertical.nodes[0].height, 12);
  assert.equal((await call('distribute_nodes', { nodeIds: [photo.id, copy.id], axis: 'HORIZONTAL' })).isError, true);
  assert.ok(figma.commits >= 4);
});

test('bridge rejects wrong token, duplicate connections, handles errors, timeout and disconnect', async t => {
  await assert.rejects(createBridge({ token: 'short', port: 0 }), /random token/);
  const bridge = await createBridge({ token, port: 0, timeout: 30 });
  t.after(() => bridge.close());
  assert.throws(() => bridge.request('get_node', {}), /connect/);
  const wrong = new WebSocket(`ws://127.0.0.1:${bridge.port}/?token=wrong`);
  await new Promise(resolve => { wrong.on('error', error => { assert.match(error.message, /401/); resolve(); }); });
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/?token=${token}`);
  await once(socket, 'open');
  const second = new WebSocket(`ws://127.0.0.1:${bridge.port}/?token=${token}`);
  const [code] = await once(second, 'close');
  assert.equal(code, 1008);
  const response = once(socket, 'message');
  const request = bridge.request('get_node', {});
  const [raw] = await response;
  socket.send(JSON.stringify({ id: JSON.parse(raw).id, error: 'Node not found' }));
  await assert.rejects(request, /Node not found/);
  await assert.rejects(bridge.request('get_node', {}), /outcome may be unknown/);
  const pending = bridge.request('update_node', {});
  socket.close();
  await assert.rejects(pending, /disconnected/);
});

test('REST authentication, query encoding, rate limit and error sanitization', async () => {
  await assert.rejects(figmaGet('files/abc', {}, { token: '' }), /FIGMA_ACCESS_TOKEN/);
  const data = await figmaGet('files/abc/nodes', { ids: '1:2,3:4', depth: 2, version: undefined }, {
    token: 'secret', fetchImpl: async (url, options) => {
      assert.equal(url.origin, 'https://api.figma.com');
      assert.equal(url.searchParams.get('ids'), '1:2,3:4');
      assert.equal(url.searchParams.has('version'), false);
      assert.equal(options.headers['X-Figma-Token'], 'secret');
      assert.equal(options.redirect, 'error');
      return Response.json({ nodes: {} });
    }
  });
  assert.deepEqual(data, { nodes: {} });
  await assert.rejects(figmaGet('files/abc', {}, { token, fetchImpl: async () => new Response('secret', { status: 429, headers: { 'retry-after': '15' } }) }), /Retry after 15/);
  await assert.rejects(figmaGet('files/abc', {}, { token, fetchImpl: async () => { throw new Error('secret'); } }), error => !error.message.includes('secret'));
});

test('actual stdio process initializes and lists tools without stdout pollution', async t => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env: { ...process.env, FIGMA_BRIDGE_TOKEN: token, FIGMA_BRIDGE_PORT: '0' }, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 72);
  const status = await client.callTool({ name: 'figma_status', arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).connected, false);
});

test('multiple MCP sessions share one bridge with authenticated and validated commands', async t => {
  createServer({});
  const owner = createSharedBridge({ token, port: 0, validateCommand });
  const { port } = await owner.status();
  t.after(() => owner.close());
  const other = createSharedBridge({ token, port, validateCommand });
  t.after(() => other.close());
  const socket = new WebSocket(`ws://localhost:${port}/?token=${token}`);
  await once(socket, 'open');
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    socket.send(JSON.stringify({ id: message.id, result: { source: message.command, args: message.args } }));
  });
  assert.equal((await other.status()).connected, true);
  const results = await Promise.all([
    owner.request('get_document', { depth: 1 }), other.request('get_document', { depth: 2 })
  ]);
  assert.equal(results[0].args.depth, 1);
  assert.equal(results[1].args.depth, 2);
  await assert.rejects(other.request('delete_node', { nodeId: '1:1', confirm: false }), /true/);
  const wrong = createSharedBridge({ token: 'b'.repeat(64), port, validateCommand });
  await assert.rejects(wrong.status(), /incompatible server or a different token/);
  await wrong.close();
  await other.close();
  assert.equal((await owner.status()).connected, true, 'Closing a borrower preserves the owner');
  const successor = createSharedBridge({ token, port, validateCommand });
  t.after(() => successor.close());
  await owner.close();
  assert.equal((await successor.status()).connected, false, 'A new session can own a released port');
});

test('two real stdio processes on the same port both expose all 72 tools', async t => {
  const clients = [];
  t.after(async () => { for (const client of clients.reverse()) await client.close(); });
  async function connect(port) {
    const client = new Client({ name: 'parallel-stdio', version: '1' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
      env: { ...process.env, FIGMA_BRIDGE_TOKEN: token, FIGMA_BRIDGE_PORT: String(port) }, stderr: 'pipe' }));
    return client;
  }
  const first = await connect(0);
  const result = await first.callTool({ name: 'figma_status', arguments: {} });
  const second = await connect(JSON.parse(result.content[0].text).port);
  assert.equal((await first.listTools()).tools.length, 72);
  assert.equal((await second.listTools()).tools.length, 72);
});

test('one plugin automatically connects two real bridges and serializes their Figma commands', async t => {
  const bridges = await Promise.all([createBridge({ token, port: 0 }), createBridge({ token, port: 0 })]);
  const window = {};
  const figma = mockFigma(message => window.onmessage({ source: null, data: { pluginMessage: message } }));
  vm.runInNewContext(pluginCode, { figma, __html__: '', Uint8Array });
  let active = 0, maximum = 0;
  figma.currentPage.loadAsync = async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
  };
  const elements = Object.fromEntries(['port', 'token', 'status', 'connect', 'disconnect', 'hide'].map(id => [id, { value: '' }]));
  const context = vm.createContext({ window, document: { getElementById: id => elements[id] },
    parent: { postMessage: message => figma.ui.onmessage(message.pluginMessage) }, WebSocket, setTimeout, clearTimeout });
  t.after(async () => { elements.disconnect.onclick?.(); await Promise.all(bridges.map(bridge => bridge.close())); });
  const config = { port: bridges[0].port, ports: bridges.map(bridge => bridge.port), token };
  const script = readFileSync(new URL('../plugin/ui.html', import.meta.url), 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1].replace('/* LOCAL_CONNECTION */ null', JSON.stringify(config));
  vm.runInContext(script, context);
  await new Promise(setImmediate);
  const sockets = vm.runInContext('[...channels.values()].map(channel => channel.socket)', context);
  assert.equal(sockets.length, 2);
  await Promise.all(Array.from(sockets, client => client.readyState === WebSocket.OPEN ? undefined : once(client, 'open')));
  assert.ok(bridges.every(bridge => bridge.status().connected));
  const results = await Promise.all(bridges.map((bridge, index) => bridge.request('get_document', { depth: index + 1 })));
  assert.ok(results.every(result => result.currentPage.name === 'Page 1'));
  assert.equal(maximum, 1, 'Commands from both clients must use the same Figma queue');
  await bridges[0].close();
  const result = await bridges[1].request('get_selection', { depth: 1 });
  assert.deepEqual(result, []);
});



