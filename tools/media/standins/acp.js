#!/usr/bin/env node
// A stand-in ACP agent (Agent Client Protocol version 1), the protocol Kimi Code,
// OpenCode, Gemini CLI and others speak. It reports a plan, tool calls and streamed
// text through session/update and asks before running commands.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { answerVersion, applyEdit, callTool, lines, runCommand, sceneFor, send, sleep, stream } from './common.js';

if (answerVersion()) process.exit(0);
const role = process.env.DEMO_ROLE || 'kimi';
const sessions = new Map();
const pending = new Map();
let nextId = 1;
const STATUS = { done: 'completed', now: 'in_progress', todo: 'pending' };

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const update = (sessionId, body) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `req-${nextId++}`;
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });

async function prompt(id, params) {
  const session = sessions.get(params.sessionId);
  const text = (params.prompt || []).map((part) => part.text || '').join('');
  const tokens = { inputTokens: 0, outputTokens: 0 };
  let n = 0;
  const call = (body) => update(session.id, { sessionUpdate: 'tool_call', ...body });
  const done = (toolCallId, status = 'completed') => update(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status });
  for (const [action, ...args] of sceneFor(role, text)) {
    const toolCallId = `call-${++n}`;
    if (action === 'plan') {
      update(session.id, { sessionUpdate: 'plan', entries: args[0].map(([status, content]) => ({ content, status: STATUS[status], priority: 'medium' })) });
    } else if (action === 'think') {
      update(session.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '…' } });
      await sleep(args[0]);
    } else if (action === 'read') {
      call({ toolCallId, title: `Read ${args[0]}`, kind: 'read', status: 'in_progress', locations: [{ path: path.resolve(session.cwd, args[0]) }] });
      await sleep(args[1]);
      done(toolCallId);
    } else if (action === 'edit') {
      const file = path.resolve(session.cwd, args[0]);
      const verb = fs.existsSync(file) ? 'Edit' : 'Write';
      call({ toolCallId, title: `${verb} ${args[0]}`, kind: 'edit', status: 'in_progress', locations: [{ path: file }] });
      await sleep(500);
      applyEdit(session.cwd, args[0], args[1]);
      done(toolCallId);
    } else if (action === 'run') {
      const toolCall = { toolCallId, title: args[0], kind: 'execute', status: 'pending', rawInput: { command: args[0] } };
      call(toolCall);
      const answer = await request('session/request_permission', {
        sessionId: session.id,
        toolCall,
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      if (answer.result?.outcome?.optionId === 'reject') done(toolCallId, 'failed');
      else done(toolCallId, (await runCommand(args[0], session.cwd)).code === 0 ? 'completed' : 'failed');
    } else if (action === 'tool') {
      const server = session.mcpServers[0];
      call({ toolCallId, title: `cross-harness.${args[0]}`, kind: 'other', status: 'in_progress', rawInput: args[1] });
      await callTool({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map((item) => [item.name, item.value])) }, args[0], args[1]);
      done(toolCallId);
    } else if (action === 'say') {
      await stream(args[0], (chunk) => update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } }));
    } else if (action === 'usage') {
      tokens.inputTokens += args[0];
      tokens.outputTokens += args[1];
    } else if (action === 'wait') {
      await sleep(args[0]);
    }
  }
  reply(id, { stopReason: 'end_turn', usage: { ...tokens, totalTokens: tokens.inputTokens + tokens.outputTokens } });
}

lines((message) => {
  if (message.id !== undefined && !message.method) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    return;
  }
  const { id, method, params = {} } = message;
  if (method === 'initialize') return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] });
  if (method === 'session/new') {
    const sessionId = `${role}-${randomUUID()}`;
    sessions.set(sessionId, { id: sessionId, cwd: params.cwd, mcpServers: params.mcpServers || [] });
    return reply(id, { sessionId, modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] } });
  }
  if (method === 'session/set_mode') return reply(id, {});
  if (method === 'session/prompt') return void prompt(id, params);
  if (method === 'session/cancel') return;
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});
