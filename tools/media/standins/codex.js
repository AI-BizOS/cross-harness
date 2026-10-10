#!/usr/bin/env node
// A stand-in for `codex app-server`: JSON-RPC lines without "jsonrpc", one thread,
// one turn per prompt. Commands run without asking, as Codex runs them inside its
// workspace-write sandbox. Run as `codex.js [-c key=value ...] app-server`.
import { randomUUID } from 'node:crypto';
import { answerVersion, applyEdit, callTool, lines, runCommand, sceneFor, send, sleep, stream } from './common.js';

if (answerVersion()) process.exit(0);
const argv = process.argv.slice(2);

// -c mcp_servers.NAME.command="..." / .args=[...] / .env={K="v"}
const servers = {};
for (let i = 0; i < argv.length - 1; i++) {
  const match = argv[i] === '-c' && /^mcp_servers\.([^.]+)\.(command|args|env)=(.*)$/s.exec(argv[i + 1]);
  if (!match) continue;
  const [, name, key, value] = match;
  servers[name] ||= { name };
  if (key === 'env') servers[name].env = Object.fromEntries([...value.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*")/g)].map((m) => [m[1], JSON.parse(m[2])]));
  else servers[name][key] = JSON.parse(value);
}

const threads = new Map();
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });

async function runTurn(thread, turnId, prompt) {
  const base = { threadId: thread.id, turnId };
  const item = (method, body) => notify(method, { ...base, item: body });
  let n = 0;
  notify('turn/started', { threadId: thread.id, turn: { id: turnId, status: 'inProgress' } });
  for (const [action, ...args] of sceneFor('codex', prompt)) {
    const id = `${action}-${++n}`;
    if (action === 'think') {
      item('item/started', { id, type: 'reasoning' });
      await sleep(args[0]);
      item('item/completed', { id, type: 'reasoning' });
    } else if (action === 'run') {
      const command = args[0];
      item('item/started', { id, type: 'commandExecution', command, cwd: thread.cwd, status: 'inProgress' });
      await sleep(250);
      const result = await runCommand(command, thread.cwd, (delta) => notify('item/commandExecution/outputDelta', { ...base, itemId: id, delta }));
      item('item/completed', { id, type: 'commandExecution', command, cwd: thread.cwd, status: result.code === 0 ? 'completed' : 'failed', exitCode: result.code, aggregatedOutput: result.output });
    } else if (action === 'edit') {
      const changes = [{ path: args[0], kind: 'update' }];
      item('item/started', { id, type: 'fileChange', status: 'inProgress', changes });
      await sleep(350);
      applyEdit(thread.cwd, args[0], args[1]);
      item('item/completed', { id, type: 'fileChange', status: 'completed', changes });
    } else if (action === 'tool') {
      const server = Object.values(servers)[0];
      item('item/started', { id, type: 'mcpToolCall', server: server.name, tool: args[0], status: 'inProgress' });
      await callTool(server, args[0], args[1]);
      item('item/completed', { id, type: 'mcpToolCall', server: server.name, tool: args[0], status: 'completed' });
    } else if (action === 'say') {
      item('item/started', { id, type: 'agentMessage', text: '' });
      await stream(args[0], (delta) => notify('item/agentMessage/delta', { ...base, itemId: id, delta }));
      item('item/completed', { id, type: 'agentMessage', text: args[0] });
    } else if (action === 'usage') {
      thread.tokens += args[0] + args[1];
      notify('thread/tokenUsage/updated', { ...base, tokenUsage: { last: { inputTokens: args[0], cachedInputTokens: 0, outputTokens: args[1], reasoningOutputTokens: 0, totalTokens: args[0] + args[1] }, total: { totalTokens: thread.tokens } } });
    } else if (action === 'wait') {
      await sleep(args[0]);
    }
  }
  notify('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } });
}

lines((message) => {
  const { id, method, params = {} } = message;
  if (method === 'initialize') return reply(id, { userAgent: 'troupe-demo/1' });
  if (method === 'thread/start') {
    const threadId = `thread-${randomUUID()}`;
    threads.set(threadId, { id: threadId, cwd: params.cwd, tokens: 0 });
    return reply(id, { thread: { id: threadId } });
  }
  if (method === 'turn/start') {
    const thread = threads.get(params.threadId);
    const turnId = `turn-${randomUUID().slice(0, 8)}`;
    reply(id, { turn: { id: turnId, status: 'inProgress' } });
    return void runTurn(thread, turnId, (params.input || []).map((part) => part.text || '').join(''));
  }
  if (method === 'turn/interrupt') return reply(id, {});
  if (id !== undefined && method) send({ id, error: { code: -32601, message: `unknown method ${method}` } });
});
