// `cross-harness mcp`: the collaboration tool server an agent starts over stdio (MCP,
// newline-delimited JSON-RPC 2.0). Each tool call becomes one request file in the
// agent's private mailbox (CROSS_HARNESS_MAILBOX, authenticated by CROSS_HARNESS_TOKEN); cross-harness
// answers with one response file. Files instead of sockets: harness sandboxes often
// block loopback and Unix sockets but allow writing to a directory.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIMITS, PROTOCOL_VERSION } from '../protocol/index.js';
import { FORMAT, INSTRUCTIONS, SERVER_NAME, TOOLS, TOOL_BY_NAME } from './tools.js';
import { VERSION } from '../version.js';

const MAX_LINE = 4 * 1024 * 1024;
const UNCLAIMED_MS = 10_000;
const GRACE_MS = 30_000;
const LATER = 'Continue with work that does not depend on it and collect the answer later with cross_harness_check_answers.';

const sleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/** One request file out, one response file back. */
export async function exchange({ dir, token, op, params, waitSeconds, pollMs = 150 }) {
  const id = randomUUID();
  const body = JSON.stringify({ id, op, params, token });
  if (Buffer.byteLength(body) > LIMITS.mailboxRequestBytes) {
    return { ok: false, error: { code: 'CROSS_HARNESS_COLLAB_INVALID', message: 'The request is larger than 256 KB; shorten it.' } };
  }
  const file = path.join(dir, 'requests', `${id}.json`);
  const reply = path.join(dir, 'responses', `${id}.json`);
  const started = Date.now();
  fs.writeFileSync(`${file}.tmp`, body, { mode: 0o600, flag: 'wx' });
  fs.renameSync(`${file}.tmp`, file);
  for (;;) {
    await sleep(pollMs);
    let text = null;
    try {
      text = fs.readFileSync(reply, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (text !== null) {
      fs.rmSync(reply, { force: true });
      return JSON.parse(text);
    }
    const elapsed = Date.now() - started;
    // A request cross-harness never picked up is withdrawn so it cannot run much later.
    if (elapsed > UNCLAIMED_MS && fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
        return { ok: false, error: { code: 'CROSS_HARNESS_COLLAB_UNAVAILABLE', message: 'cross-harness is not responding; collaboration is unavailable right now.' } };
      } catch {
        /* Claimed just now. */
      }
    }
    if (elapsed > waitSeconds * 1000 + GRACE_MS) return { ok: true, timedOut: true };
  }
}

async function callTool(env, name, args, pollMs) {
  const tool = TOOL_BY_NAME[name];
  const params = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (!env.CROSS_HARNESS_MAILBOX || !env.CROSS_HARNESS_TOKEN) {
    return textResult('Collaboration is unavailable: this agent was not started by cross-harness with a mailbox, so other agents, the board and the user cannot be reached from here.', true);
  }
  const asked = params.wait_seconds == null || params.wait_seconds === '' ? tool.wait : Number(params.wait_seconds);
  const waitSeconds = tool.wait ? (Number.isFinite(asked) ? Math.min(Math.max(asked, 0), LIMITS.waitSeconds) : tool.wait) : 0;
  let reply;
  try {
    reply = await exchange({ dir: env.CROSS_HARNESS_MAILBOX, token: env.CROSS_HARNESS_TOKEN, op: tool.op, params, waitSeconds, pollMs });
  } catch (cause) {
    return textResult(`Collaboration is unavailable right now (${cause.code || cause.message}).`, true);
  }
  if (reply.timedOut) return tool.wait ? textResult(`Still waiting for a reply. ${LATER}`) : textResult('cross-harness did not respond in time; try again shortly.', true);
  if (!reply.ok) return textResult(`${reply.error?.code ? `${reply.error.code}: ` : ''}${reply.error?.message || 'The request failed.'}`, true);
  try {
    return textResult(FORMAT[tool.op](reply.result), reply.result?.status === 'failed');
  } catch {
    return textResult(JSON.stringify(reply.result ?? null));
  }
}

const rpcError = (code, message) => Object.assign(new Error(message), { rpcCode: code });

async function handle(method, params, env, pollMs) {
  if (method === 'initialize') {
    return {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: VERSION, title: `cross-harness collaboration (${PROTOCOL_VERSION})` },
      instructions: INSTRUCTIONS,
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  if (method === 'tools/call') {
    if (typeof params?.name !== 'string' || !TOOL_BY_NAME[params.name]) throw rpcError(-32602, `Unknown tool: ${String(params?.name)}`);
    return callTool(env, params.name, params.arguments, pollMs);
  }
  throw rpcError(-32601, `Method not found: ${method}`);
}

/** Serves MCP on the given streams until the input ends. */
export function serve({ input = process.stdin, output = process.stdout, env = process.env, pollMs = 150 } = {}) {
  const send = (message) => {
    try {
      output.write(JSON.stringify(message) + '\n');
    } catch {
      /* The client went away. */
    }
  };
  output.on?.('error', () => {});
  const answer = async (message) => {
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
      return message && typeof message === 'object' && message.id !== undefined && !('result' in message) && !('error' in message)
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid Request' } }
        : null;
    }
    if (message.id === undefined) return null; // notifications/initialized, notifications/cancelled
    try {
      return { jsonrpc: '2.0', id: message.id, result: await handle(message.method, message.params, env, pollMs) };
    } catch (cause) {
      return { jsonrpc: '2.0', id: message.id, error: { code: cause.rpcCode || -32603, message: cause.message } };
    }
  };
  const receive = async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(message)) {
      const replies = (await Promise.all(message.map(answer))).filter(Boolean);
      if (replies.length) send(replies);
      return;
    }
    const reply = await answer(message);
    if (reply) send(reply);
  };
  let buffer = '';
  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0; ) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) receive(line).catch(() => {});
    }
    if (buffer.length > MAX_LINE) {
      buffer = '';
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Message too large' } });
    }
  });
  return new Promise((resolve) => {
    input.once('end', resolve);
    input.once('close', resolve);
  });
}
