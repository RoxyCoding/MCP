import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createHttpServer } from 'node:http';

export async function createBridge({ token, port = 3055, timeout = 30000, validateCommand }) {
  if (!token || token.length < 32 || token === 'replace-with-a-long-random-token') {
    throw new Error('FIGMA_BRIDGE_TOKEN must be a random token of at least 32 characters. Run npm run setup.');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid FIGMA_BRIDGE_PORT.');
  let socket;
  const pending = new Map();
  function authorized(supplied) {
    const a = Buffer.from(supplied || ''), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  let bridge;
  const http = createHttpServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (!authorized(req.headers.authorization?.replace(/^Bearer /, ''))) {
      res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized.' })); return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.end(JSON.stringify({ service: 'local-figma-bridge-v1', ...bridge.status() })); return;
    }
    if (req.method !== 'POST' || req.url !== '/command') { res.writeHead(404); res.end('{}'); return; }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 12 * 1024 * 1024) throw new Error('Command too large.');
        chunks.push(chunk);
      }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!validateCommand) throw new Error('Remote commands are not enabled.');
      const args = validateCommand(message.command, message.args);
      const result = await bridge.request(message.command, args);
      res.end(JSON.stringify({ result }));
    } catch (error) {
      res.writeHead(400); res.end(JSON.stringify({ error: error.message }));
    }
  });
  const wss = new WebSocketServer({
    server: http, maxPayload: 16 * 1024 * 1024,
    verifyClient: ({ req }) => {
      const supplied = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
      return authorized(supplied);
    }
  });
  wss.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) { wss.close(); throw error; }
  wss.on('connection', client => {
    if (socket) { client.close(1008, 'A Figma plugin is already connected.'); return; }
    socket = client;
    client.on('error', () => {});
    client.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { client.close(1008, 'Invalid JSON.'); return; }
      if (!message || typeof message !== 'object') { client.close(1008, 'Invalid response.'); return; }
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(String(message.error)));
      else request.resolve(message.result);
    });
    client.on('close', () => {
      if (socket !== client) return;
      socket = undefined;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Figma disconnected. Operation outcome may be unknown; inspect the document before retrying.'));
      }
      pending.clear();
    });
  });
  bridge = {
    port: wss.address().port,
    status: () => ({ connected: socket?.readyState === WebSocket.OPEN, port: wss.address()?.port }),
    request(command, args) {
      if (socket?.readyState !== WebSocket.OPEN) throw new Error('Open the Local Figma MCP plugin and connect it first.');
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Figma timed out. Operation outcome may be unknown; inspect the document before retrying.'));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, command, args }), error => {
          if (!error || !pending.has(id)) return;
          clearTimeout(timer); pending.delete(id); reject(new Error('Failed to send command to Figma.'));
        });
      });
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise(resolve => wss.close(resolve));
      http.closeIdleConnections();
      await new Promise(resolve => http.close(resolve));
    }
  };
  return bridge;
}
