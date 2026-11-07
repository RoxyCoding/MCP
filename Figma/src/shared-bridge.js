import { createBridge } from './bridge.js';

// shortcut: the first MCP process owns the bridge; reconnect the plugin if that process exits. Use a separate daemon if uninterrupted ownership is needed.
export function createSharedBridge(options) {
  let owned;
  let starting;
  let closed = false;
  const base = `http://127.0.0.1:${options.port}`;
  const headers = { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' };
  async function status() {
    const response = await fetch(base + '/status', { headers, signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) throw new Error('Bridge port is occupied by an incompatible server or a different token.');
    const value = await response.json();
    if (value.service !== 'local-figma-bridge-v1') throw new Error('Incompatible bridge on this port.');
    return { connected: value.connected, port: value.port };
  }
  async function ensure() {
    if (closed) throw new Error('Bridge is closed.');
    if (owned) return owned.status();
    if (!starting) starting = (async () => {
      try { owned = await createBridge(options); return owned.status(); }
      catch (error) { if (error.code !== 'EADDRINUSE') throw error; return status(); }
    })().finally(() => { starting = undefined; });
    return starting;
  }
  return {
    status: ensure,
    async request(command, args) {
      await ensure();
      if (owned) return owned.request(command, args);
      let response;
      try {
        response = await fetch(base + '/command', {
          method: 'POST', headers, body: JSON.stringify({ command, args }),
          signal: AbortSignal.timeout(35000), redirect: 'error'
        });
      } catch { throw new Error('Shared bridge disconnected or timed out. Outcome may be unknown; inspect Figma before retrying.'); }
      const value = await response.json();
      if (!response.ok || value.error) throw new Error(value.error || 'Shared bridge failed.');
      return value.result;
    },
    async close() { closed = true; await starting?.catch(() => {}); await owned?.close(); }
  };
}
