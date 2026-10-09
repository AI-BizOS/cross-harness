// Shared helpers for the mock agents used in tests. A prompt may carry directives:
//   [approve]            ask for permission to run `npm test` before answering
//   [edit:FILE=TEXT]     write TEXT to FILE (relative to the working directory)
//   [ask-edit:FILE]      ask for permission to edit FILE (nothing is written)
//   [slow]               take 3 seconds (cancellable)
//   [fail]               end the turn with an error
//   [mcp:TOOL JSON]      call TOOL on the first MCP server the client configured
//   [echo]               answer with the prompt only
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export function directives(text) {
  const out = { approve: /\[approve\]/.test(text), slow: /\[slow\]/.test(text), fail: /\[fail\]/.test(text), echo: /\[echo\]/.test(text), edits: [], askEdits: [], mcp: [] };
  for (const match of text.matchAll(/\[ask-edit:([^\]]+)\]/g)) out.askEdits.push(match[1]);
  for (const match of text.matchAll(/\[edit:([^=\]]+)=([^\]]*)\]/g)) out.edits.push({ file: match[1], text: match[2] });
  for (const match of text.matchAll(/\[mcp:([a-z_]+) (\{.*?\})\]/g)) out.mcp.push({ tool: match[1], args: JSON.parse(match[2]) });
  return out;
}

export function applyEdits(cwd, edits) {
  for (const { file, text } of edits) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text + '\n');
  }
}

export function lines(onLine) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    onLine(message);
  });
  rl.on('close', () => process.exit(0));
}

export const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal MCP stdio client: start the server, initialize, call one tool. */
export async function callMcpTool(server, tool, args) {
  const env = { ...process.env, ...(server.env || {}) };
  const child = spawn(server.command, server.args || [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 1;
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const reply = await request('tools/call', { name: tool, arguments: args });
  child.stdin.end();
  child.kill();
  const text = reply.result?.content?.map((part) => part.text).join('') ?? JSON.stringify(reply.error);
  return { text, isError: Boolean(reply.result?.isError || reply.error) };
}

/** Appends a line to MOCK_LOG so tests can assert what the agent received. */
export function log(entry) {
  if (process.env.MOCK_LOG) fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(entry) + '\n');
}
