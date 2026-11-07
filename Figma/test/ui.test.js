import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../plugin/ui.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function ui({ throws = false, config = null } = {}) {
  const elements = Object.fromEntries(['port', 'token', 'status', 'connect', 'disconnect', 'hide'].map(id => [id, { disabled: false, value: '' }]));
  elements.port.value = '3055';
  elements.token.value = '  ' + 'a'.repeat(64) + '\n';
  elements.disconnect.disabled = true;
  elements.hide.disabled = true;
  const messages = [];
  const timers = new Map();
  let sequence = 0;
  const sockets = [];
  const window = {};
  class WebSocket {
    static OPEN = 1;
    constructor(url) {
      if (throws) throw new Error('Blocked');
      this.url = url; this.readyState = 0; sockets.push(this);
    }
    close() { this.closed = true; }
    send(value) { (this.sent ||= []).push(JSON.parse(value)); }
  }
  vm.runInNewContext(script.replace('/* LOCAL_CONNECTION */ null', JSON.stringify(config).replace(/</g, '\\u003c')), {
    document: { getElementById: id => elements[id] }, window, parent: { postMessage: message => messages.push(message) }, WebSocket,
    setTimeout: callback => { timers.set(++sequence, callback); return sequence; },
    clearTimeout: id => timers.delete(id)
  });
  return { elements, sockets, timers, messages, window };
}

test('UI WebSocket error restores reconnect button even without a close event', () => {
  const { elements, sockets, timers } = ui();
  elements.connect.onclick();
  assert.equal(elements.connect.disabled, true);
  assert.equal(elements.disconnect.disabled, false);
  assert.equal(new URL(sockets[0].url).searchParams.get('token'), 'a'.repeat(64));
  sockets[0].onerror();
  assert.equal(elements.connect.disabled, false);
  assert.equal(elements.disconnect.disabled, false);
  assert.equal(timers.size, 1);
  assert.equal(sockets[0].closed, true);
  elements.connect.onclick();
  sockets[1].onopen();
  assert.match(elements.status.textContent, /接続しました/);
  assert.equal(timers.size, 0);
  elements.disconnect.onclick();
  assert.equal(elements.connect.disabled, false);
  assert.equal(timers.size, 0);
});

test('bundled connection ignores stale manual port and token settings', () => {
  const config = { port: 3055, token: 'c'.repeat(64) };
  const first = ui({ config });
  first.elements.token.value = '';
  first.window.onmessage({ data: { pluginMessage: { type: 'connection-config', config: null } } });
  assert.equal(first.sockets.length, 1);
  assert.equal(new URL(first.sockets[0].url).searchParams.get('token'), config.token);
  assert.equal(new URL(first.sockets[0].url).port, '3055');
  const saved = ui({ config });
  saved.window.onmessage({ data: { pluginMessage: { type: 'connection-config', config: { port: 3057, token: 'old'.repeat(20) } } } });
  assert.equal(new URL(saved.sockets[0].url).port, '3055');
  assert.equal(new URL(saved.sockets[0].url).searchParams.get('token'), config.token);
  const manual = ui({ config });
  manual.elements.connect.onclick();
  manual.window.onmessage({ data: { pluginMessage: { type: 'connection-config', config: null } } });
  assert.equal(manual.sockets.length, 1);
  assert.equal(new URL(manual.sockets[0].url).searchParams.get('token'), 'a'.repeat(64));
});

test('automatic ports stay connected independently and route replies to the requesting server', () => {
  const config = { port: 3055, ports: [3055, 3056, 3057], token: 'c'.repeat(64) };
  const { elements, sockets, messages, timers, window } = ui({ config });
  window.onmessage({ data: { pluginMessage: { type: 'connection-config', config: null } } });
  assert.deepEqual(sockets.map(client => new URL(client.url).port), ['3055', '3056', '3057']);
  for (const client of sockets) { client.readyState = 1; client.onopen(); }
  assert.equal(timers.size, 0);
  sockets[0].onmessage({ data: JSON.stringify({ id: 'codex-1', command: 'get_selection', args: {} }) });
  sockets[1].onmessage({ data: JSON.stringify({ id: 'claude-1', command: 'get_document', args: {} }) });
  window.onmessage({ data: { pluginMessage: { id: 'claude-1', result: { client: 'claude' } } } });
  window.onmessage({ data: { pluginMessage: { id: 'codex-1', result: { client: 'codex' } } } });
  assert.equal(sockets[0].sent[0].result.client, 'codex');
  assert.equal(sockets[1].sent[0].result.client, 'claude');
  sockets[0].onmessage({ data: JSON.stringify({ id: 'stale', command: 'get_selection', args: {} }) });
  const messageCount = messages.length;
  sockets[0].onerror();
  assert.equal(messages.length, messageCount, 'A lost port must not reveal a hidden UI while another port is connected');
  assert.equal(elements.hide.disabled, false);
  assert.match(elements.status.textContent, /3056/);
  assert.equal(timers.size, 1);
  const retry = [...timers.entries()][0]; timers.delete(retry[0]); retry[1]();
  assert.equal(sockets.length, 4, 'Only the missing port is retried');
  assert.equal(new URL(sockets[3].url).port, '3055');
  window.onmessage({ data: { pluginMessage: { id: 'stale', result: {} } } });
  assert.equal(sockets[3].sent, undefined);
  elements.disconnect.onclick();
  assert.ok(sockets.every(client => client.closed));
  assert.equal(timers.size, 0);
});

test('an unavailable or busy port cannot disconnect a working port', () => {
  const { sockets, elements, window } = ui({ config: { port: 3055, ports: [3055, 3056], token: 'c'.repeat(64) } });
  window.onmessage({ data: { pluginMessage: { type: 'connection-config', config: null } } });
  sockets[0].readyState = 1; sockets[0].onopen();
  sockets[1].onclose({ code: 1008 });
  assert.equal(sockets[0].closed, undefined);
  assert.equal(elements.hide.disabled, false);
  assert.match(elements.status.textContent, /3055/);
});

test('manifest uses the generated local UI and its bundled token matches the local environment', async () => {
  const { existsSync } = await import('node:fs');
  const { parseEnv } = await import('node:util');
  const manifest = JSON.parse(readFileSync(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.ui, 'ui.local.html');
  const generated = readFileSync(new URL('../plugin/ui.local.html', import.meta.url), 'utf8');
  assert.ok(!generated.includes('/* LOCAL_CONNECTION */'));
  const envPath = new URL('../.env', import.meta.url);
  if (existsSync(envPath)) {
    const env = parseEnv(readFileSync(envPath, 'utf8'));
    if (env.FIGMA_BRIDGE_TOKEN?.length >= 32) {
      const bundled = JSON.parse(generated.match(/const bundledConnection = (.*);/)[1]);
      assert.ok(bundled.token === env.FIGMA_BRIDGE_TOKEN, 'Generated credential must match .env');
    }
  }
});

test('UI recovers from synchronous constructor errors and connection timeouts', () => {
  const blocked = ui({ throws: true });
  blocked.elements.connect.onclick();
  assert.equal(blocked.elements.connect.disabled, false);
  assert.match(blocked.elements.status.textContent, /ネットワーク許可設定/);
  const waiting = ui();
  waiting.elements.connect.onclick();
  [...waiting.timers.values()][0]();
  assert.equal(waiting.elements.connect.disabled, false);
  assert.equal(waiting.sockets[0].closed, true);
  assert.match(waiting.elements.status.textContent, /タイムアウト/);
});

test('manifest permits the WebSocket origin used by each configured client', () => {
  const manifest = JSON.parse(readFileSync(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));
  for (const port of [3055, 3056, 3057]) {
    assert.ok(manifest.networkAccess.devAllowedDomains.includes('ws://localhost:' + port));
  }
});

test('hiding the UI preserves its socket and disconnection requests UI recovery', () => {
  const { elements, sockets, messages } = ui();
  elements.connect.onclick();
  sockets[0].readyState = 1;
  sockets[0].onopen();
  assert.equal(elements.hide.disabled, false);
  elements.hide.onclick();
  assert.equal(messages.at(-1).pluginMessage.type, 'hide-ui');
  assert.equal(sockets[0].closed, undefined);
  sockets[0].onerror();
  assert.equal(messages.at(-1).pluginMessage.type, 'show-ui');
  assert.equal(elements.hide.disabled, true);
});

test('saved connection automatically connects and retries until explicitly disconnected', () => {
  const { elements, sockets, messages, timers, window } = ui();
  assert.equal(messages[0].pluginMessage.type, 'load-connection');
  window.onmessage({ data: { pluginMessage: { type: 'connection-config', config: { port: 3056, token: 'b'.repeat(64) } } } });
  assert.equal(sockets.length, 1);
  assert.equal(new URL(sockets[0].url).port, '3056');
  sockets[0].onerror();
  assert.match(elements.status.textContent, /自動再接続/);
  const retry = [...timers.entries()][0]; timers.delete(retry[0]); retry[1]();
  assert.equal(sockets.length, 2);
  sockets[1].readyState = 1; sockets[1].onopen();
  assert.equal(messages.at(-1).pluginMessage.type, 'save-connection');
  assert.equal(messages.at(-1).pluginMessage.config.token, 'b'.repeat(64));
  elements.disconnect.onclick();
  assert.equal(timers.size, 0);
  assert.equal(elements.disconnect.disabled, true);
});

test('delayed saved settings cannot override manual input and invalid stored settings do not connect', () => {
  const state = ui();
  state.elements.connect.onclick();
  state.window.onmessage({ data: { pluginMessage: { type: 'connection-config', config: { port: 3057, token: 'b'.repeat(64) } } } });
  assert.equal(state.sockets.length, 1);
  assert.equal(new URL(state.sockets[0].url).port, '3055');
  const invalid = ui();
  invalid.window.onmessage({ data: { pluginMessage: { type: 'connection-config', config: { port: 0, token: 'short' } } } });
  assert.equal(invalid.sockets.length, 0);
});

test('UI returns correlated Figma replies with a null source and drops unsolicited or stale messages', () => {
  const { elements, sockets, messages, window } = ui();
  elements.connect.onclick();
  const socket = sockets[0];
  socket.readyState = 1; socket.onopen();
  socket.onmessage({ data: JSON.stringify({ id: 'request-1', command: 'get_document', args: { depth: 1 } }) });
  assert.equal(messages.at(-1).pluginMessage.id, 'request-1');
  window.onmessage({ source: null, data: { pluginMessage: { id: 'unknown', result: {} } } });
  assert.equal(socket.sent, undefined);
  window.onmessage({ source: null, data: { pluginMessage: { id: 'request-1', result: { name: 'テスト' } } } });
  assert.equal(socket.sent[0].result.name, 'テスト');
  window.onmessage({ source: null, data: { pluginMessage: { id: 'request-1', result: {} } } });
  assert.equal(socket.sent.length, 1, 'Duplicate replies are ignored');
  socket.onmessage({ data: JSON.stringify({ id: 'request-2', command: 'get_selection', args: {} }) });
  elements.disconnect.onclick();
  elements.connect.onclick();
  sockets[1].readyState = 1; sockets[1].onopen();
  window.onmessage({ source: null, data: { pluginMessage: { id: 'request-2', result: [] } } });
  window.onmessage({ source: null, data: null });
  assert.equal(sockets[1].sent, undefined, 'Old connection replies are ignored');
});
