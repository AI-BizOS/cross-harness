#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json
// --permission-prompt-tool stdio`. Like Claude Code in its default permission mode it
// asks before every edit, command and MCP tool, with absolute file paths; Troupe's
// policy answers or asks the user.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { answerVersion, applyEdit, callTool, lines, runCommand, sceneFor, send, sleep } from './common.js';

if (answerVersion()) process.exit(0);
const argv = process.argv.slice(2);
const flag = (key) => {
  const index = argv.indexOf(key);
  return index >= 0 ? argv[index + 1] : null;
};
const sessionId = flag('--resume') || randomUUID();
const servers = flag('--mcp-config') ? JSON.parse(flag('--mcp-config')).mcpServers : {};
const controls = new Map();
let messages = 0;

send({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), tools: ['Bash', 'Read', 'Edit', 'Write', 'mcp__troupe__troupe_ask_agent'] });

const assistant = (content) => send({ type: 'assistant', message: { id: `msg-${++messages}`, role: 'assistant', content }, parent_tool_use_id: null, session_id: sessionId });
const toolResult = (id, text, isError = false) => send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, session_id: sessionId });
const permission = (toolName, input) =>
  new Promise((resolve) => {
    const requestId = `perm-${randomUUID().slice(0, 8)}`;
    controls.set(requestId, resolve);
    send({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: toolName, input } });
  });

/** One tool call: announce it, ask when Claude Code would, then run it. */
async function useTool(name, input, run, { ask = true } = {}) {
  const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  assistant([{ type: 'tool_use', id, name, input }]);
  if (ask) {
    const answer = await permission(name, input);
    if (answer?.behavior !== 'allow') return toolResult(id, answer?.message || 'The user denied this action.', true);
  }
  const result = await run();
  toolResult(id, result.text, result.isError);
}

async function runTurn(prompt) {
  let answer = '';
  let usage = { input_tokens: 0, output_tokens: 0 };
  for (const [action, ...args] of sceneFor('claude', prompt)) {
    if (action === 'think' || action === 'wait') await sleep(args[0]);
    else if (action === 'read') {
      const file = path.resolve(args[0]);
      await useTool('Read', { file_path: file }, async () => (await sleep(args[1]), { text: 'ok' }), { ask: false });
    } else if (action === 'edit') {
      const file = path.resolve(args[0]);
      const change = args[1];
      const [name, input] = change.write !== undefined ? ['Write', { file_path: file, content: change.write }] : ['Edit', { file_path: file, old_string: change.replace?.[0] ?? '', new_string: change.replace?.[1] ?? change.append }];
      await useTool(name, input, async () => (await sleep(300), applyEdit(process.cwd(), args[0], change), { text: `Updated ${file}` }));
    } else if (action === 'run') {
      await useTool('Bash', { command: args[0], description: 'Run the tests' }, async () => {
        const result = await runCommand(args[0], process.cwd());
        return { text: result.output, isError: result.code !== 0 };
      });
    } else if (action === 'tool') {
      const server = Object.entries(servers)[0];
      await useTool(`mcp__${server[0]}__${args[0]}`, args[1], async () => ({ text: await callTool(server[1], args[0], args[1]) }));
    } else if (action === 'say') {
      // Without partial messages Claude Code sends each text block whole.
      assistant([{ type: 'text', text: args[0] }]);
      if (!args[1]?.interim) answer = args[0];
      await sleep(400);
    } else if (action === 'usage') {
      usage = { input_tokens: args[0], output_tokens: args[1] };
    }
  }
  send({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: sessionId, usage });
}

lines((message) => {
  if (message.type === 'user') return void runTurn((message.message?.content || []).map((part) => part.text || '').join(''));
  if (message.type === 'control_response') {
    const response = message.response || {};
    controls.get(response.request_id)?.(response.response);
    controls.delete(response.request_id);
  }
});
