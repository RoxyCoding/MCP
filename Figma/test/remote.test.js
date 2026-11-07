import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createSharedBridge } from '../src/shared-bridge.js';
import { validateCommand } from '../src/server.js';
import { startHttpServer } from '../src/http.js';

const token = 'b'.repeat(64);
const httpToken = 'c'.repeat(64);

async function connect(t, port, secret = httpToken) {
  const client = new Client({ name: 'remote-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } }
  });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test('remote HTTP MCP relays tool calls to the plugin bridge', async t => {
  const bridge = createSharedBridge({ token, port: 0, validateCommand });
  const { port: bridgePort } = await bridge.status();
  t.after(() => bridge.close());
  const http = await startHttpServer({ bridge, token: httpToken, port: 0 });
  t.after(() => http.close());
  const client = await connect(t, http.port);
  assert.equal((await client.listTools()).tools.length, 72);
  assert.equal(JSON.parse((await client.callTool({ name: 'figma_status', arguments: {} })).content[0].text).connected, false);
  const socket = new WebSocket(`ws://localhost:${bridgePort}/?token=${token}`);
  t.after(() => socket.close());
  await once(socket, 'open');
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    socket.send(JSON.stringify({ id: message.id, result: { command: message.command, args: message.args } }));
  });
  const result = await client.callTool({ name: 'figma_get_document', arguments: { depth: 2 } });
  assert.deepEqual(JSON.parse(result.content[0].text), { command: 'get_document', args: { depth: 2 } });
  const invalid = await client.callTool({ name: 'figma_get_node', arguments: { nodeId: 'bad' } });
  assert.equal(invalid.isError, true);
});

test('remote HTTP MCP rejects missing or wrong tokens, other paths and hosts', async t => {
  await assert.rejects(startHttpServer({ bridge: {}, token: 'short', port: 0 }), /MCP_HTTP_TOKEN/);
  const http = await startHttpServer({ bridge: {}, token: httpToken, port: 0, allowedHosts: ['figma.example.com'] });
  t.after(() => http.close());
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  // fetch cannot override Host, so use node:http directly.
  const send = (method, path, headers) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: http.port, method, path, headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers
    } }, res => {
      let text = '';
      res.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? body : undefined);
  });
  const auth = { Authorization: `Bearer ${httpToken}` }, host = { Host: 'figma.example.com' };
  assert.equal((await send('POST', '/other', { ...auth, ...host })).status, 404);
  assert.equal((await send('POST', '/mcp', auth)).status, 403);
  assert.equal((await send('POST', '/mcp', host)).status, 401);
  assert.equal((await send('POST', '/mcp', { ...host, Authorization: `Bearer ${'d'.repeat(64)}` })).status, 401);
  const ok = await send('POST', '/mcp', { ...auth, ...host });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.text).result.tools.length, 72);
  assert.equal((await send('GET', '/mcp', { ...auth, ...host })).status, 405);
});

test('remote entry point starts from environment variables', async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/remote.js', import.meta.url))], {
    env: { ...process.env, FIGMA_BRIDGE_TOKEN: token, FIGMA_BRIDGE_PORT: '0', MCP_HTTP_TOKEN: httpToken, MCP_HTTP_PORT: '0' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  t.after(() => child.kill());
  let log = '';
  for await (const chunk of child.stderr) { log += chunk; if (log.includes('\n')) break; }
  const port = Number(/remote MCP on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(log)?.[1]);
  assert.ok(port, log);
  const client = await connect(t, port);
  assert.equal((await client.listTools()).tools.length, 72);
});
