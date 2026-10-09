#!/usr/bin/env node
// A scriptable stand-in for `claude -p --input-format stream-json ...` used in tests.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyEdits, callMcpTool, directives, lines, log, send, sleep } from './mock-common.js';

const name = process.env.MOCK_NAME || 'mock-claude';
const argv = process.argv.slice(2);
const flag = (key) => {
  const index = argv.indexOf(key);
  return index >= 0 ? argv[index + 1] : null;
};
if (flag('--input-format') !== 'stream-json' || flag('--output-format') !== 'stream-json' || flag('--permission-prompt-tool') !== 'stdio') {
  process.stderr.write('mock-claude: unexpected arguments\n');
  process.exit(2);
}
const stateFile = process.env.MOCK_STATE ? path.join(process.env.MOCK_STATE, `${name}-sessions.json`) : null;
const known = () => (stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : []);
const resume = flag('--resume');
const sessionId = resume && known().includes(resume) ? resume : randomUUID();
if (stateFile) fs.writeFileSync(stateFile, JSON.stringify([...new Set([...known(), sessionId])]));
const mcp = flag('--mcp-config') ? JSON.parse(flag('--mcp-config')).mcpServers : {};
log({ agent: name, start: true, mode: flag('--permission-mode'), model: flag('--model'), resume, sessionId, mcp: Object.keys(mcp), strict: argv.includes('--strict-mcp-config') });
send({ type: 'system', subtype: 'init', session_id: sessionId, tools: ['Bash', 'Read', 'Edit'] });

const controls = new Map();
let turn = null;
const assistant = (id, content) => send({ type: 'assistant', message: { id, role: 'assistant', content }, parent_tool_use_id: null, session_id: sessionId });
const toolResult = (id, ok = true, text = 'ok') => send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: !ok }] }, session_id: sessionId });
const ask = (input, tool = 'Bash') =>
  new Promise((resolve) => {
    const requestId = `perm-${randomUUID().slice(0, 8)}`;
    controls.set(requestId, resolve);
    send({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: tool, input } });
  });

async function run(text) {
  const d = directives(text);
  const current = { interrupted: false };
  turn = current;
  log({ agent: name, prompt: text });
  assistant('msg-a1', [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: 'README.md' } }]);
  toolResult('tu-read');
  let note = '';
  if (d.approve) {
    assistant('msg-a2', [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'npm test' } }]);
    const response = await ask({ command: 'npm test' });
    if (current.interrupted) return finishInterrupted();
    const allowed = response?.behavior === 'allow';
    toolResult('tu-bash', allowed, allowed ? 'tests passed' : response?.message || 'denied');
    note += allowed ? ' (npm test allowed)' : ' (npm test denied)';
  }
  for (const file of d.askEdits) {
    const response = await ask({ file_path: path.resolve(process.cwd(), file), old_string: 'a', new_string: 'b' }, 'Edit');
    if (current.interrupted) return finishInterrupted();
    note += ` (edit ${file} ${response?.behavior === 'allow' ? 'allowed' : 'denied'})`;
  }
  if (d.edits.length) {
    assistant('msg-a3', [{ type: 'tool_use', id: 'tu-edit', name: 'Edit', input: { file_path: d.edits[0].file } }]);
    applyEdits(process.cwd(), d.edits);
    toolResult('tu-edit');
  }
  for (const call of d.mcp) {
    const server = Object.values(mcp)[0];
    if (!server) {
      note += ' [no mcp server]';
      continue;
    }
    const result = await callMcpTool(server, call.tool, call.args);
    note += `\n[${call.tool}] ${result.text}`;
  }
  if (d.slow) {
    for (let i = 0; i < 30 && !current.interrupted; i++) await sleep(100);
  }
  if (current.interrupted) return finishInterrupted();
  if (d.fail) {
    turn = null;
    return send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['mock failure'], session_id: sessionId });
  }
  const answer = `${name} answered: ${text.replace(/\[[^\]]*\]/g, '').trim()}${note}`;
  assistant('msg-final', [{ type: 'text', text: answer }]);
  turn = null;
  send({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: sessionId, usage: { input_tokens: 10, output_tokens: 5 } });
}

function finishInterrupted() {
  turn = null;
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId });
}

lines((message) => {
  if (message.type === 'user') {
    const text = (message.message?.content || []).map((part) => part.text || '').join('');
    void run(text);
    return;
  }
  if (message.type === 'control_response') {
    const response = message.response || {};
    const waiter = controls.get(response.request_id);
    if (waiter) {
      controls.delete(response.request_id);
      waiter(response.response);
    }
    return;
  }
  if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
    if (turn) turn.interrupted = true;
    for (const [id, waiter] of controls) {
      controls.delete(id);
      waiter(null);
    }
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
  }
});
