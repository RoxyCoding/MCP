import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const env = fileURLToPath(new URL('../.env', import.meta.url));
if (!existsSync(env)) {
  writeFileSync(env, `FIGMA_BRIDGE_TOKEN=${randomBytes(32).toString('hex')}\nFIGMA_BRIDGE_PORT=3055\nFIGMA_ACCESS_TOKEN=\n`, { flag: 'wx', mode: 0o600 });
}
// Existing values are never overwritten; only a missing remote token is appended.
const values = parseEnv(readFileSync(env, 'utf8'));
if (!values.MCP_HTTP_TOKEN) {
  const prefix = readFileSync(env, 'utf8').endsWith('\n') ? '' : '\n';
  appendFileSync(env, `${prefix}MCP_HTTP_TOKEN=${randomBytes(32).toString('hex')}\nMCP_HTTP_HOST=127.0.0.1\nMCP_HTTP_PORT=3100\n`);
}
const remote = parseEnv(readFileSync(env, 'utf8'));
await import('./build-plugin.js');
writeFileSync(new URL('../mcp.local.json', import.meta.url), JSON.stringify({
  mcpServers: { 'local-figma': {
    command: process.execPath,
    args: [`--env-file=${env}`, fileURLToPath(new URL('../src/index.js', import.meta.url))]
  } }
}, null, 2) + '\n');
writeFileSync(new URL('../mcp.remote.json', import.meta.url), JSON.stringify({
  mcpServers: { 'local-figma': {
    type: 'http',
    url: `http://localhost:${remote.MCP_HTTP_PORT || 3100}/mcp`,
    headers: { Authorization: `Bearer ${remote.MCP_HTTP_TOKEN}` }
  } }
}, null, 2) + '\n', { mode: 0o600 });
console.log(`Setup complete: ${root}mcp.local.json and ${root}mcp.remote.json (tokens are stored in .env)`);
