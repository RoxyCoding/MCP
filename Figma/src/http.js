import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';

const MAX_BODY = 16 * 1024 * 1024;

// Stateless Streamable HTTP: each POST gets its own McpServer and transport, so no per-client session state leaks.
export async function startHttpServer({ bridge, token, host = '127.0.0.1', port = 3100, path = '/mcp', allowedHosts, rest }) {
  if (!token || token.length < 32 || token === 'replace-with-a-long-random-token') {
    throw new Error('MCP_HTTP_TOKEN must be a random token of at least 32 characters. Run npm run setup.');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid MCP_HTTP_PORT.');
  const expected = Buffer.from(token);
  function authorized(header) {
    const supplied = Buffer.from(/^Bearer (.+)$/.exec(header || '')?.[1] || '');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  function reply(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }
  const hosts = allowedHosts?.length ? new Set(allowedHosts.map(value => value.toLowerCase())) : null;
  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== path) { reply(res, 404, { error: 'Not found.' }); return; }
    if (hosts && !hosts.has((req.headers.host || '').toLowerCase().replace(/:\d+$/, ''))) { reply(res, 403, { error: 'Host not allowed.' }); return; }
    if (!authorized(req.headers.authorization)) {
      reply(res, 401, { error: 'Unauthorized.' }, { 'WWW-Authenticate': 'Bearer' }); return;
    }
    if (req.method !== 'POST') {
      reply(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { Allow: 'POST' }); return;
    }
    let body;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new Error('Request too large.');
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      reply(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: error.message }, id: null }); return;
    }
    const server = createServer(bridge, rest);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) reply(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null });
    }
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => { http.off('error', reject); resolve(); });
  });
  return {
    port: http.address().port,
    async close() {
      http.closeAllConnections();
      await new Promise(resolve => http.close(resolve));
    }
  };
}
