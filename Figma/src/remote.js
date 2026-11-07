import { createSharedBridge } from './shared-bridge.js';
import { validateCommand } from './server.js';
import { startHttpServer } from './http.js';

let bridge;
let http;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await http?.close();
  await bridge?.close();
}
try {
  bridge = createSharedBridge({ token: process.env.FIGMA_BRIDGE_TOKEN, port: Number(process.env.FIGMA_BRIDGE_PORT || 3055), validateCommand });
  const initial = await bridge.status();
  const host = process.env.MCP_HTTP_HOST || '127.0.0.1';
  http = await startHttpServer({
    bridge, token: process.env.MCP_HTTP_TOKEN, host, port: Number(process.env.MCP_HTTP_PORT || 3100),
    allowedHosts: process.env.MCP_HTTP_ALLOWED_HOSTS?.split(',').map(value => value.trim()).filter(Boolean)
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.error(`Local Figma MCP: bridge on 127.0.0.1:${initial.port}, remote MCP on http://${host}:${http.port}/mcp`);
} catch (error) {
  console.error(`Local Figma MCP failed: ${error.code === 'EADDRINUSE' ? 'Port is already in use. Change FIGMA_BRIDGE_PORT or MCP_HTTP_PORT.' : error.message}`);
  await shutdown();
  process.exitCode = 1;
}
