#!/usr/bin/env node
// A stand-in for `bizos acp`, BizOS Code's Agent Client Protocol mode. It answers the
// way BizOS Code's adapter does: its own tool names (coding_read, coding_multi_edit,
// coding_create, coding_command_start) reported with kind "other", text streamed as
// message chunks, no plan, and approvals with two options, allow once and reject. Like
// BizOS Code it asks before creating a file or running a command, and before editing
// one only in Build mode; "Accept edits" (cross-harness's workspace mode) edits existing files
// without asking, and YOLO asks for nothing.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { answerVersion, applyEdit, lines, runCommand, sceneFor, send, sleep, stream } from './common.js';

if (answerVersion()) process.exit(0);
const MODES = [
  { id: 'ask', name: 'Build' },
  { id: 'plan', name: 'Plan' },
  { id: 'workspace', name: 'Accept edits' },
  { id: 'full', name: 'YOLO' },
];
const sessions = new Map();
const pending = new Map();
let nextId = 1;

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const update = (sessionId, body) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `permission_${nextId++}`;
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
// Whether BizOS Code asks before a tool in the session's mode (reads never ask).
const asks = (session, name) => session.mode !== 'full' && (name !== 'coding_multi_edit' || session.mode === 'ask');
const permission = (session, toolCallId, title, rawInput) =>
  request('session/request_permission', {
    sessionId: session.id,
    toolCall: { toolCallId, title, kind: 'other', status: 'pending', rawInput },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  }).then((outcome) => outcome?.optionId === 'allow');

const sha256 = (file) => (fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);

async function prompt(id, params) {
  const session = sessions.get(params.sessionId);
  const text = (params.prompt || []).map((part) => part.text || '').join('\n');
  let n = 0;
  const tool = (name, rawInput) => {
    const toolCallId = `call_${++n}`;
    update(session.id, { sessionUpdate: 'tool_call', toolCallId, title: name, kind: 'other', status: 'in_progress', rawInput });
    return (ok) => update(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: ok ? 'completed' : 'failed' });
  };
  for (const [action, ...args] of sceneFor('bizos', text)) {
    if (action === 'think' || action === 'wait') await sleep(args[0]);
    else if (action === 'say') await stream(args[0], (chunk) => update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } }));
    else if (action === 'read') {
      const finish = tool('coding_read', { path: args[0] });
      await sleep(args[1]);
      finish(true);
    } else if (action === 'edit') {
      const [file, change] = args;
      const target = path.resolve(session.cwd, file);
      const [name, rawInput] = fs.existsSync(target)
        ? ['coding_multi_edit', { files: [{ path: file, expectedSha256: sha256(target), edits: [{ oldText: change.replace?.[0] ?? '', newText: change.replace?.[1] ?? change.append }] }] }]
        : ['coding_create', { path: file, content: change.write }];
      if (asks(session, name) && !(await permission(session, `call_${n + 1}`, name, rawInput))) continue;
      const finish = tool(name, rawInput);
      await sleep(400);
      applyEdit(session.cwd, file, change);
      finish(true);
    } else if (action === 'run') {
      const rawInput = { command: args[0], waitMs: 120000 };
      if (asks(session, 'coding_command_start') && !(await permission(session, `call_${n + 1}`, 'coding_command_start', rawInput))) continue;
      const finish = tool('coding_command_start', rawInput);
      await runCommand(args[0], session.cwd);
      // The tool reports the exit code in its result; the call itself succeeded.
      finish(true);
    }
  }
  reply(id, { stopReason: 'end_turn' });
}

lines((message) => {
  if (message.id !== undefined && !message.method) {
    pending.get(message.id)?.(message.result?.outcome);
    pending.delete(message.id);
    return;
  }
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false } },
      agentInfo: { name: 'bizos-code', title: 'BizOS CODE', version: 'demo' },
      authMethods: [],
    });
  }
  if (method === 'session/new') {
    const sessionId = randomUUID();
    sessions.set(sessionId, { id: sessionId, cwd: params.cwd, mode: 'ask' });
    return reply(id, { sessionId, modes: { currentModeId: 'ask', availableModes: MODES } });
  }
  if (method === 'session/set_mode') {
    const session = sessions.get(params.sessionId);
    if (session) session.mode = params.modeId;
    return reply(id, {});
  }
  if (method === 'session/prompt') return void prompt(id, params);
  if (method === 'session/cancel') return;
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown ACP method: ${method}` } });
});
