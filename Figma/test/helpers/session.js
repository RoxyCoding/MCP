import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, validateCommand } from '../../src/server.js';
import { mockFigma } from './figma.js';

export async function session(t) {
  const figma = mockFigma(() => {});
  const context = vm.createContext({ figma, __html__: '' });
  vm.runInContext(readFileSync(new URL('../../plugin/code.js', import.meta.url), 'utf8'), context);
  const server = createServer({ request: (command, args) => context.execute(command, validateCommand(command, args)) });
  const client = new Client({ name: 'design-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name, args = {}) => client.callTool({ name: 'figma_' + name, arguments: args });
  const data = async (name, args) => {
    const response = await call(name, args);
    assert.equal(response.isError, undefined, response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  return { figma, call, data, context };
}
