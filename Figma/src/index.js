import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSharedBridge } from './shared-bridge.js';
import { createServer, validateCommand } from './server.js';

let bridge;
let server;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await bridge?.close();
  await server?.close();
}
try {
  bridge = createSharedBridge({ token: process.env.FIGMA_BRIDGE_TOKEN, port: Number(process.env.FIGMA_BRIDGE_PORT || 3055), validateCommand });
  server = createServer(bridge);
  const initial = await bridge.status();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const onclose = transport.onclose;
  transport.onclose = () => { onclose?.(); void shutdown(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.error(`Local Figma MCP: bridge available on 127.0.0.1:${initial.port}`);
} catch (error) {
  console.error(`Local Figma MCP failed: ${error.code === 'EADDRINUSE' ? 'Bridge port is already in use. Stop the other server or change FIGMA_BRIDGE_PORT and the plugin manifest.' : error.message}`);
  await shutdown();
  process.exitCode = 1;
}
