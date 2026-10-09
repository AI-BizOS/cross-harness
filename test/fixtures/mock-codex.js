#!/usr/bin/env node
// A scriptable `codex app-server` for tests: JSON-RPC lines without "jsonrpc".
// Run as `mock-codex.js [-c key=value ...] app-server`.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyEdits, callMcpTool, directives, lines, log, send, sleep } from './mock-common.js';

const name = process.env.MOCK_NAME || 'mock-codex';
const argv = process.argv.slice(2);
if (argv.at(-1) !== 'app-server') {
  process.stderr.write('expected app-server\n');
  process.exit(2);
}

// -c mcp_servers.NAME.command="..." / .args=[...] / .env={K="v"}
const servers = {};
for (let i = 0; i < argv.length - 1; i++) {
  if (argv[i] !== '-c') continue;
  const match = /^mcp_servers\.([^.]+)\.(command|args|env)=(.*)$/s.exec(argv[i + 1]);
  if (!match) continue;
  const [, server, key, value] = match;
  servers[server] ||= {};
  if (key === 'env') servers[server].env = Object.fromEntries([...value.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*")/g)].map((m) => [m[1], JSON.parse(m[2])]));
  else servers[server][key] = JSON.parse(value);
}

const threads = new Map();
const pending = new Map();
let nextId = 5000;
const stateFile = process.env.MOCK_STATE ? path.join(process.env.MOCK_STATE, `${name}-threads.json`) : null;
const known = () => (stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : []);
const remember = (id) => {
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify([...new Set([...known(), id])]));
};
const reply = (id, result) => send({ id, result });
const replyError = (id, code, message) => send({ id, error: { code, message } });
const notify = (method, params) => send({ method, params });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });

async function runTurn(thread, turn, text) {
  const d = directives(text);
  const base = { threadId: thread.id, turnId: turn.id };
  notify('turn/started', { threadId: thread.id, turn: { id: turn.id, status: 'inProgress' } });
  notify('item/started', { ...base, item: { id: `r-${turn.id}`, type: 'reasoning' } });
  notify('item/completed', { ...base, item: { id: `r-${turn.id}`, type: 'reasoning' } });
  if (d.fail) return notify('turn/completed', { threadId: thread.id, turn: { id: turn.id, status: 'failed', error: { message: 'mock failure' } } });
  let note = '';
  if (d.approve) {
    notify('item/started', { ...base, item: { id: 'cmd1', type: 'commandExecution', command: 'npm test', status: 'inProgress' } });
    const answer = await request('item/commandExecution/requestApproval', { ...base, itemId: 'cmd1', command: 'npm test', cwd: thread.cwd, reason: 'run the tests' });
    const decision = answer.result?.decision;
    if (decision === 'cancel' || turn.interrupted) return notify('turn/completed', { threadId: thread.id, turn: { id: turn.id, status: 'interrupted' } });
    const ok = decision === 'accept' || decision === 'acceptForSession';
    if (ok) notify('item/commandExecution/outputDelta', { ...base, itemId: 'cmd1', delta: 'tests passed\n' });
    notify('item/completed', { ...base, item: { id: 'cmd1', type: 'commandExecution', command: 'npm test', status: ok ? 'completed' : 'declined', aggregatedOutput: ok ? 'tests passed\n' : '' } });
    note += ` (npm test ${decision})`;
  }
  for (const [index, file] of d.askEdits.entries()) {
    const itemId = `fca${index}`;
    const changes = [{ path: path.resolve(thread.cwd, file) }];
    notify('item/started', { ...base, item: { id: itemId, type: 'fileChange', status: 'inProgress', changes } });
    const answer = await request('item/fileChange/requestApproval', { ...base, itemId, reason: 'edit a file' });
    const decision = answer.result?.decision;
    if (decision === 'cancel' || turn.interrupted) return notify('turn/completed', { threadId: thread.id, turn: { id: turn.id, status: 'interrupted' } });
    const ok = decision === 'accept' || decision === 'acceptForSession';
    notify('item/completed', { ...base, item: { id: itemId, type: 'fileChange', status: ok ? 'completed' : 'declined', changes } });
    note += ` (edit ${file} ${ok ? 'allowed' : 'denied'})`;
  }
  if (d.edits.length) {
    notify('item/started', { ...base, item: { id: 'fc1', type: 'fileChange', status: 'inProgress', changes: d.edits.map((e) => ({ path: e.file })) } });
    applyEdits(thread.cwd, d.edits);
    notify('item/completed', { ...base, item: { id: 'fc1', type: 'fileChange', status: 'completed', changes: d.edits.map((e) => ({ path: e.file })) } });
  }
  for (const call of d.mcp) {
    const server = Object.values(servers)[0];
    if (!server) {
      note += ' [no mcp server]';
      continue;
    }
    notify('item/started', { ...base, item: { id: `mcp-${call.tool}`, type: 'mcpToolCall', server: Object.keys(servers)[0], tool: call.tool, status: 'inProgress' } });
    const result = await callMcpTool(server, call.tool, call.args);
    notify('item/completed', { ...base, item: { id: `mcp-${call.tool}`, type: 'mcpToolCall', server: Object.keys(servers)[0], tool: call.tool, status: 'completed' } });
    note += `\n[${call.tool}] ${result.text}`;
  }
  if (d.slow) {
    for (let i = 0; i < 30 && !turn.interrupted; i++) await sleep(100);
    if (turn.interrupted) return notify('turn/completed', { threadId: thread.id, turn: { id: turn.id, status: 'interrupted' } });
  }
  const answer = `${name} answered: ${text.replace(/\[[^\]]*\]/g, '').trim()}${turn.steered.length ? ` +steer(${turn.steered.join('|')})` : ''}${note}`;
  notify('item/started', { ...base, item: { id: `m-${turn.id}`, type: 'agentMessage', text: '' } });
  for (const part of [answer.slice(0, 10), answer.slice(10)]) {
    notify('item/agentMessage/delta', { ...base, itemId: `m-${turn.id}`, delta: part });
    await sleep(5);
  }
  notify('item/completed', { ...base, item: { id: `m-${turn.id}`, type: 'agentMessage', text: answer } });
  thread.tokens += 15;
  notify('thread/tokenUsage/updated', { ...base, tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 15 }, total: { totalTokens: thread.tokens } } });
  notify('turn/completed', { threadId: thread.id, turn: { id: turn.id, status: 'completed' } });
}

lines(async (message) => {
  if (message.id !== undefined && !message.method) {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
    return;
  }
  const { id, method, params = {} } = message;
  if (method === 'initialize') return reply(id, { userAgent: 'mock-codex/1' });
  if (method === 'initialized') return;
  if (method === 'thread/start' || method === 'thread/resume') {
    let threadId = params.threadId;
    if (method === 'thread/resume' && !known().includes(threadId)) return replyError(id, -32600, `no rollout found for thread id ${threadId}`);
    if (method === 'thread/start') threadId = `thread-${randomUUID()}`;
    threads.set(threadId, { id: threadId, cwd: params.cwd, tokens: 0, turn: null });
    remember(threadId);
    log({ agent: name, method, threadId, approvalPolicy: params.approvalPolicy, sandbox: params.sandbox, model: params.model ?? null, mcp: Object.keys(servers) });
    return reply(id, { thread: { id: threadId } });
  }
  if (method === 'turn/start') {
    const thread = threads.get(params.threadId);
    if (!thread) return replyError(id, -32600, 'unknown thread');
    const text = (params.input || []).map((part) => part.text || '').join('');
    const turn = { id: `turn-${randomUUID().slice(0, 8)}`, interrupted: false, steered: [] };
    thread.turn = turn;
    log({ agent: name, method, text });
    reply(id, { turn: { id: turn.id, status: 'inProgress' } });
    // Let the steer test land before the answer is written.
    if (/\[steerable\]/.test(text)) await sleep(400);
    return runTurn(thread, turn, text);
  }
  if (method === 'turn/steer') {
    const turn = threads.get(params.threadId)?.turn;
    if (!turn || turn.id !== params.expectedTurnId) return replyError(id, -32600, 'no active turn');
    turn.steered.push((params.input || []).map((part) => part.text).join(''));
    return reply(id, {});
  }
  if (method === 'turn/interrupt') {
    const turn = threads.get(params.threadId)?.turn;
    if (turn) turn.interrupted = true;
    return reply(id, {});
  }
  if (id !== undefined) replyError(id, -32601, `unknown method ${method}`);
});
