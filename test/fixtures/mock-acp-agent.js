#!/usr/bin/env node
// A scriptable ACP agent for tests (protocol version 1). See mock-common.js for the
// prompt directives. MOCK_NAME names it in answers; MOCK_STATE keeps sessions for
// session/load; MOCK_AUTH_FAIL makes session/new fail as unauthenticated.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyEdits, callMcpTool, directives, lines, log, send, sleep } from './mock-common.js';

const name = process.env.MOCK_NAME || 'mock-acp';
const sessions = new Map();
const pending = new Map();
let nextId = 1000;
const MODES = [
  { id: 'default', name: 'Default' },
  { id: 'acceptEdits', name: 'Accept Edits' },
  { id: 'plan', name: 'Plan' },
  { id: 'bypassPermissions', name: 'Bypass Permissions' },
];
const stateFile = process.env.MOCK_STATE ? path.join(process.env.MOCK_STATE, `${name}-sessions.json`) : null;
const known = () => (stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : []);
const remember = (id) => {
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify([...new Set([...known(), id])]));
};

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const update = (sessionId, body) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });

async function prompt(id, params) {
  const session = sessions.get(params.sessionId);
  if (!session) return replyError(id, -32602, 'unknown session');
  const text = (params.prompt || []).map((part) => part.text || '').join('');
  const d = directives(text);
  session.cancelled = false;
  log({ agent: name, method: 'session/prompt', text, mode: session.mode, cwd: session.cwd, mcp: session.mcpServers.map((s) => s.name) });
  if (d.fail) return replyError(id, -32603, 'mock failure');
  update(session.id, { sessionUpdate: 'plan', entries: [{ content: 'Read the task', status: 'completed' }, { content: 'Answer', status: 'in_progress' }] });
  update(session.id, { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read README.md', kind: 'read', status: 'pending', locations: [{ path: 'README.md' }] });
  update(session.id, { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed' });
  let note = '';
  if (d.approve) {
    const toolCall = { toolCallId: 'cmd-1', title: 'npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } };
    update(session.id, { sessionUpdate: 'tool_call', ...toolCall });
    const answer = await request('session/request_permission', {
      sessionId: session.id,
      toolCall,
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = answer.result?.outcome;
    if (outcome?.outcome === 'cancelled') return reply(id, { stopReason: 'cancelled' });
    note = outcome?.optionId === 'reject' ? ' (npm test denied)' : ` (npm test ${outcome?.optionId})`;
    update(session.id, { sessionUpdate: 'tool_call_update', toolCallId: 'cmd-1', status: outcome?.optionId === 'reject' ? 'failed' : 'completed' });
  }
  for (const file of d.askEdits) {
    const toolCall = { toolCallId: `ask-edit-${file}`, title: `Edit ${file}`, kind: 'edit', status: 'pending', locations: [{ path: path.resolve(session.cwd, file) }] };
    update(session.id, { sessionUpdate: 'tool_call', ...toolCall });
    const answer = await request('session/request_permission', {
      sessionId: session.id,
      toolCall,
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = answer.result?.outcome;
    if (outcome?.outcome === 'cancelled') return reply(id, { stopReason: 'cancelled' });
    update(session.id, { sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId, status: outcome?.optionId === 'reject' ? 'failed' : 'completed' });
    note += ` (edit ${file} ${outcome?.optionId === 'reject' ? 'denied' : 'allowed'})`;
  }
  if (d.edits.length) {
    update(session.id, { sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'Edit files', kind: 'edit', status: 'in_progress', locations: d.edits.map((e) => ({ path: e.file })) });
    applyEdits(session.cwd, d.edits);
    update(session.id, { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'completed' });
  }
  for (const call of d.mcp) {
    const server = session.mcpServers[0];
    if (!server) {
      note += ` [no mcp server]`;
      continue;
    }
    const env = Object.fromEntries((server.env || []).map((item) => [item.name, item.value]));
    const result = await callMcpTool({ command: server.command, args: server.args, env }, call.tool, call.args);
    note += `\n[${call.tool}] ${result.text}`;
  }
  if (d.slow) {
    for (let i = 0; i < 30 && !session.cancelled; i++) await sleep(100);
    if (session.cancelled) return reply(id, { stopReason: 'cancelled' });
  }
  const answer = d.echo ? text : `${name} answered: ${text.replace(/\[[^\]]*\]/g, '').trim()}${note}`;
  const middle = Math.ceil(answer.length / 2);
  update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer.slice(0, middle) } });
  await sleep(10);
  update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer.slice(middle) } });
  reply(id, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } });
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
  if (method === 'initialize') return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
  if (method === 'session/new' || method === 'session/load') {
    if (process.env.MOCK_AUTH_FAIL) return replyError(id, -32000, 'Authentication required');
    let sessionId = params.sessionId;
    if (method === 'session/load') {
      if (!known().includes(sessionId)) return replyError(id, -32602, 'Session not found');
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } });
    } else sessionId = `${name}-${randomUUID()}`;
    sessions.set(sessionId, { id: sessionId, cwd: params.cwd, mcpServers: params.mcpServers || [], mode: 'default', cancelled: false });
    remember(sessionId);
    log({ agent: name, method, sessionId, cwd: params.cwd });
    return reply(id, { ...(method === 'session/new' ? { sessionId } : {}), modes: { currentModeId: 'default', availableModes: MODES } });
  }
  if (method === 'session/set_mode') {
    const session = sessions.get(params.sessionId);
    if (session) session.mode = params.modeId;
    log({ agent: name, method, modeId: params.modeId });
    return reply(id, {});
  }
  if (method === 'session/prompt') return prompt(id, params);
  if (method === 'session/cancel') {
    const session = sessions.get(params.sessionId);
    if (session) session.cancelled = true;
    return;
  }
  if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
});
