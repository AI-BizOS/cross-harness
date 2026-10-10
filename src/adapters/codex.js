// Codex over `codex app-server`: newline-delimited JSON-RPC without the "jsonrpc"
// member. One thread per agent, resumable by id; one turn per prompt; text can be
// steered into a running turn; command and file-change approvals are answered by
// cross-harness. Method names follow `codex app-server generate-json-schema`.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODES, fail } from '../protocol/errors.js';
import { JsonRpcPeer } from '../util/jsonrpc.js';
import { spawnAgent, lifecycle, tail } from '../util/process.js';
import { oneLine } from '../util/text.js';
import { CLIENT_INFO, TEXT_INTERVAL_MS, assertMode, assertPrompt, normalizeMcpServers, safeEmitter, within } from './common.js';

// plan runs read-only and cross-harness declines every approval it is asked for.
const MODES = {
  full: { approvalPolicy: 'never', sandbox: 'workspace-write' },
  workspace: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  ask: { approvalPolicy: 'on-request', sandbox: 'read-only' },
  plan: { approvalPolicy: 'on-request', sandbox: 'read-only' },
};
const STATUS = { inProgress: 'running', completed: 'done', failed: 'failed', declined: 'failed' };
const DECISIONS = { allow_once: 'accept', allow_always: 'acceptForSession', deny: 'decline', cancel: 'cancel' };
// thread/resume refusals for a thread this CODEX_HOME does not have. Anything else is
// a real failure and must not silently become a fresh thread without context.
const UNKNOWN_THREAD = /no rollout found|thread not found|invalid thread id|no thread with id/i;
const HANDSHAKE_MS = 30_000;
const THREAD_MS = 120_000;
const CONTROL_MS = 15_000;
const DRAIN_MS = 10_000;
const OUTPUT_TAIL = 4096;

// `-c` values are TOML. A JSON string is a valid TOML basic string once DEL is escaped.
const toml = (value) => JSON.stringify(value).replace(/\x7f/g, '\\u007f');
export function mcpConfigArgs(servers) {
  return normalizeMcpServers(servers).flatMap(({ name, command, args, env }) => {
    const key = `mcp_servers.${name}`;
    const vars = Object.entries(env);
    return [
      '-c',
      `${key}.command=${toml(command)}`,
      '-c',
      `${key}.args=[${args.map(toml).join(',')}]`,
      ...(vars.length ? ['-c', `${key}.env={${vars.map(([variable, value]) => `${variable}=${toml(value)}`).join(',')}}`] : []),
    ];
  });
}

const lastLine = (text) =>
  (
    String(text)
      .split(/\r\n|\r|\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() || ''
  ).slice(0, 200);

export function createCodexSession({ binary, args = [], env, cwd, label = 'Codex', spawnProcess }) {
  let child = null;
  let peer = null;
  let life = null;
  let stderr = { text: '' };
  let threadId = null;
  let turn = null;
  let closing = null;
  let emit = safeEmitter(null);
  let reportedTotal = null;
  const approvals = new Map();
  const endedTurns = new Set();

  const cancelledError = () => fail(CODES.CANCELLED, `${label}: turn cancelled`);
  const busyError = () => fail(CODES.BUSY, `${label} is still answering; wait or stop it first`);
  const failedError = (message) => fail(CODES.PROVIDER_FAILED, `${label} failed${message ? `: ${String(message).slice(0, 500)}` : ''}`);
  const usable = () => {
    if (!threadId || !peer) throw fail(CODES.CLOSED, `${label} session has not started`);
    if (peer.closed) throw peer.closed;
  };

  function newTurn() {
    const current = { id: null, settled: false, messages: new Map(), answerId: null, commands: new Map(), files: new Map(), usage: null, timer: null, textAt: 0, sent: null, interrupt: null };
    current.result = new Promise((resolve, reject) => Object.assign(current, { resolve, reject }));
    current.started = new Promise((resolve) => (current.markStarted = resolve));
    current.ended = new Promise((resolve) => (current.markEnded = resolve));
    return current;
  }
  const answer = (current) => current.messages.get(current.answerId) || '';
  function flush(current, force) {
    clearTimeout(current.timer);
    current.timer = null;
    const text = answer(current);
    if (text && (force || text !== current.sent)) {
      current.sent = text;
      current.textAt = Date.now();
      emit({ type: 'text', text });
    }
  }
  function showText(current) {
    if (current.settled || current.timer) return;
    const wait = current.textAt + TEXT_INTERVAL_MS - Date.now();
    if (wait <= 0) flush(current, false);
    else {
      current.timer = setTimeout(flush, wait, current, false);
      current.timer.unref?.();
    }
  }
  function settle(current, error, value) {
    if (current.settled) return;
    current.settled = true;
    current.cleanup?.();
    flush(current, !error);
    for (const entry of approvals.values()) if (entry.turn === current) entry.respond('cancel');
    if (error) current.reject(error);
    else current.resolve(value);
  }
  // Codex finished the turn (or can no longer run it); the next prompt may start.
  function end(current, error, value) {
    settle(current, error, value);
    if (turn === current) turn = null;
    if (current.id) {
      endedTurns.add(current.id);
      if (endedTurns.size > 64) endedTurns.delete(endedTurns.values().next().value);
    }
    current.markStarted(current.id);
    current.markEnded();
  }
  function adopt(current, id) {
    current.id = id;
    current.markStarted(id);
  }

  function onNotification(method, params) {
    if (!threadId || params.threadId !== threadId) return;
    if (method === 'serverRequest/resolved') {
      approvals.get(params.requestId)?.respond('cancel');
      return;
    }
    const current = turn;
    const id = params.turnId ?? params.turn?.id;
    if (!current || typeof id !== 'string') return;
    // Events can precede the turn/start response: adopt the first turn that has not ended.
    if (current.id === null) {
      if (endedTurns.has(id)) return;
      adopt(current, id);
    } else if (id !== current.id) return;
    if (method === 'turn/completed') {
      const { status, error } = params.turn || {};
      end(current, status === 'completed' ? null : status === 'interrupted' ? cancelledError() : failedError(error?.message), {
        text: answer(current),
        stopReason: 'end_turn',
        usage: current.usage,
      });
      return;
    }
    if (current.settled) return;
    if (method === 'item/started' || method === 'item/completed') {
      onItem(current, params.item, method === 'item/completed');
      return;
    }
    if (method === 'item/agentMessage/delta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
      if (!current.messages.has(params.itemId)) current.answerId = params.itemId;
      current.messages.set(params.itemId, (current.messages.get(params.itemId) || '') + params.delta);
      if (params.itemId === current.answerId) showText(current);
      return;
    }
    if (method === 'item/commandExecution/outputDelta' && typeof params.delta === 'string') {
      const entry = current.commands.get(params.itemId);
      if (entry) {
        entry.output = (entry.output + params.delta).slice(-OUTPUT_TAIL);
        commandActivity(current, params.itemId, false);
      }
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      onUsage(current, params.tokenUsage);
      return;
    }
    // willRetry:true is a dropped stream that Codex reconnects by itself.
    if (method === 'error' && !params.willRetry) settle(current, failedError(params.error?.message));
  }

  function onItem(current, item, completed) {
    if (!item || typeof item.id !== 'string') return;
    const status = STATUS[item.status] || (completed ? 'done' : 'running');
    if (item.type === 'agentMessage') {
      // The answer is the turn's last agent message; earlier ones are commentary.
      if (!current.messages.has(item.id)) current.answerId = item.id;
      current.messages.set(item.id, completed && typeof item.text === 'string' ? item.text : current.messages.get(item.id) || item.text || '');
      showText(current);
      return;
    }
    if (item.type === 'reasoning') {
      emit({ type: 'activity', id: 'thinking', kind: 'thinking', title: 'Thinking', status });
      return;
    }
    if (item.type === 'commandExecution') {
      const entry = current.commands.get(item.id) || { command: '', output: '', at: 0, status };
      current.commands.set(item.id, entry);
      if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput) entry.output = item.aggregatedOutput.slice(-OUTPUT_TAIL);
      entry.command = (Array.isArray(item.command) ? item.command.join(' ') : item.command) || entry.command;
      entry.status = status;
      commandActivity(current, item.id, true);
      return;
    }
    if (item.type === 'fileChange') {
      const paths = (Array.isArray(item.changes) ? item.changes : []).map((change) => change?.path).filter((value) => typeof value === 'string');
      current.files.set(item.id, paths);
      emit({ type: 'activity', id: item.id, kind: 'edit', title: oneLine(paths.join(', ') || 'File changes', 160), status });
      return;
    }
    if (item.type === 'mcpToolCall') {
      emit({
        type: 'activity',
        id: item.id,
        kind: 'tool',
        title: [item.server, item.tool].filter(Boolean).join('.') || 'Tool call',
        status,
        ...(item.error?.message ? { detail: oneLine(item.error.message, 200) } : {}),
      });
    }
  }

  function commandActivity(current, id, force) {
    const entry = current.commands.get(id);
    if (!entry || (!force && Date.now() - entry.at < TEXT_INTERVAL_MS)) return;
    entry.at = Date.now();
    emit({ type: 'activity', id, kind: 'command', title: oneLine(entry.command || 'Command', 160), status: entry.status, detail: oneLine(lastLine(entry.output), 200) });
  }

  // `last` is one model request. The thread total only grows, so an unchanged total
  // is the same request reported again and is not counted twice.
  function onUsage(current, usage) {
    const last = usage?.last;
    const mark = usage?.total?.totalTokens;
    if (!last || (Number.isFinite(mark) && mark === reportedTotal)) return;
    reportedTotal = mark;
    const value = {
      input_tokens: last.inputTokens || 0,
      cached_input_tokens: last.cachedInputTokens || 0,
      output_tokens: last.outputTokens || 0,
      reasoning_output_tokens: last.reasoningOutputTokens || 0,
      total_tokens: last.totalTokens || 0,
    };
    current.usage = current.usage ? Object.fromEntries(Object.entries(value).map(([key, count]) => [key, current.usage[key] + count])) : value;
    emit({ type: 'usage', usage: value });
  }

  function onRequest(method, params, rpcId) {
    const kind = method === 'item/commandExecution/requestApproval' ? 'command' : method === 'item/fileChange/requestApproval' ? 'edit' : null;
    if (!kind) throw fail(CODES.RPC_UNSUPPORTED, `cross-harness does not provide ${method}`, { rpcCode: -32601 });
    const current = turn && (turn.id === null || turn.id === params.turnId) ? turn : null;
    if (!current || current.settled) return { decision: 'cancel' };
    const rawCommand = kind === 'command' ? params.command || current.commands.get(params.itemId)?.command : null;
    const command = Array.isArray(rawCommand) ? rawCommand.join(' ') : rawCommand;
    // File-change requests carry no paths; they come from the item started just before.
    const title = kind === 'edit' ? `Apply changes: ${(current.files.get(params.itemId) || []).join(', ') || 'files'}` : command || 'Run command';
    const detail = (kind === 'edit' ? [params.reason, params.grantRoot] : [params.reason, params.cwd]).filter((value) => typeof value === 'string' && value).join('\n');
    return new Promise((resolve) => {
      const respond = (choice) => {
        if (!Object.hasOwn(DECISIONS, choice)) throw fail(CODES.APPROVAL_INVALID, `Unknown approval choice: ${choice}`);
        if (approvals.get(rpcId)?.respond !== respond) return false;
        approvals.delete(rpcId);
        resolve({ decision: DECISIONS[choice] });
        return true;
      };
      approvals.set(rpcId, { turn: current, respond });
      const sent = emit({
        type: 'approval',
        id: randomUUID(),
        kind,
        title: oneLine(title, 160),
        detail,
        ...(typeof command === 'string' ? { command } : {}),
        ...(kind === 'edit' ? { paths: [...(current.files.get(params.itemId) || []), ...(typeof params.grantRoot === 'string' && params.grantRoot ? [params.grantRoot] : [])] } : {}),
        options: ['allow_once', 'allow_always', 'deny'],
        respond,
      });
      if (!sent) respond('cancel');
    });
  }

  async function start({ sessionId = null, model = null, permissionMode = 'ask', mcpServers = [], onEvent } = {}) {
    if (child || closing) throw fail(CODES.START_FAILED, `${label} session already started or closed`);
    assertMode(permissionMode);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail(CODES.START_FAILED, 'The working directory must be an absolute path');
    if (model !== null && (typeof model !== 'string' || !model.trim())) throw fail(CODES.ARGUMENT_INVALID, 'Invalid model id');
    if (sessionId !== null && (typeof sessionId !== 'string' || !sessionId.trim())) throw fail(CODES.SESSION_INVALID, 'Invalid session id');
    const argv = [...args, ...mcpConfigArgs(mcpServers), 'app-server'];
    emit = safeEmitter(onEvent);
    try {
      child = spawnAgent(binary, argv, { cwd, env, spawnProcess });
    } catch (error) {
      child = null;
      throw fail(CODES.START_FAILED, `${label} failed to start: ${error.code || error.message}`);
    }
    life = lifecycle(child);
    stderr = tail(child.stderr);
    peer = new JsonRpcPeer({ input: child.stdout, output: child.stdin, jsonrpc: false, label, onNotification, onRequest });
    child.once('error', (error) => peer.close(fail(CODES.START_FAILED, `${label} failed to start: ${error.code || error.message}`)));
    child.once('close', (code, signal) => {
      const error = fail(CODES.PROCESS_EXITED, `${label} exited (${signal || code})`, { exitCode: code, signal, stderr: stderr.text });
      peer.close(error);
      if (turn) end(turn, error);
      for (const entry of approvals.values()) entry.respond('cancel');
    });
    try {
      await peer.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null }, { timeoutMs: HANDSHAKE_MS });
      peer.notify('initialized');
      const settings = { cwd, ...MODES[permissionMode], ...(model ? { model } : {}) };
      // cross-harness keeps its own transcript, so history is not replayed on resume.
      const resumed = sessionId
        ? await peer.request('thread/resume', { threadId: sessionId, ...settings, excludeTurns: true }, { timeoutMs: THREAD_MS }).catch((error) => {
            if (error.code === CODES.RPC_ERROR && UNKNOWN_THREAD.test(error.message)) return null;
            throw error;
          })
        : null;
      const result = resumed || (await peer.request('thread/start', settings, { timeoutMs: THREAD_MS }));
      const id = result?.thread?.id;
      if (typeof id !== 'string' || !id) throw fail(CODES.SESSION_UNKNOWN, `${label} did not return a thread id`);
      threadId = id;
      emit({ type: 'session', sessionId: id });
      return { sessionId: id, resumed: Boolean(resumed) };
    } catch (error) {
      void close();
      if (error.code === CODES.RPC_ERROR && /auth|login|sign in|api key/i.test(error.message)) {
        throw fail(CODES.AUTH_REQUIRED, `${label} is not signed in. Run \`codex login\` in a terminal. (${error.message})`);
      }
      throw error;
    }
  }

  async function prompt(text, { signal } = {}) {
    assertPrompt(text);
    usable();
    signal?.throwIfAborted();
    if (turn && !turn.settled) throw busyError();
    if (turn) {
      // A stopped turn may still be winding down; a new turn/start would merge into it.
      const previous = turn;
      await within(previous.ended, DRAIN_MS);
      if (turn === previous) end(previous);
      usable();
      signal?.throwIfAborted();
      if (turn) throw busyError();
    }
    const current = newTurn();
    turn = current;
    if (signal) {
      const abort = () => {
        void cancel();
        settle(current, signal.reason instanceof Error && signal.reason.name !== 'AbortError' ? signal.reason : cancelledError());
      };
      signal.addEventListener('abort', abort, { once: true });
      current.cleanup = () => signal.removeEventListener('abort', abort);
    }
    peer.request('turn/start', { threadId, input: [{ type: 'text', text }] }).then(
      (result) => {
        if (typeof result?.turn?.id === 'string' && current.id === null) adopt(current, result.turn.id);
      },
      (error) => end(current, error),
    );
    return current.result;
  }

  async function steer(text) {
    const current = turn;
    if (!current || current.settled || typeof text !== 'string' || !text.trim() || !peer || peer.closed) return false;
    const id = current.id ?? (await current.started);
    if (!id || turn !== current || current.settled) return false;
    try {
      await peer.request('turn/steer', { threadId, input: [{ type: 'text', text }], expectedTurnId: id }, { timeoutMs: CONTROL_MS });
      return true;
    } catch {
      return false;
    }
  }

  async function cancel() {
    const current = turn;
    if (!current || !peer || peer.closed) return false;
    current.interrupt ||= (async () => {
      const id = current.id ?? (await current.started);
      if (!id || turn !== current || peer.closed) return false;
      try {
        await peer.request('turn/interrupt', { threadId, turnId: id }, { timeoutMs: CONTROL_MS });
      } catch {
        return false;
      }
      // turn/completed(interrupted) settles the prompt; do not wait forever for it.
      const timer = setTimeout(() => {
        if (turn === current) end(current, cancelledError());
      }, DRAIN_MS);
      timer.unref?.();
      return true;
    })();
    return current.interrupt;
  }

  function close() {
    if (closing) return closing;
    const error = fail(CODES.CLOSED, `${label} session closed`);
    peer?.close(error);
    if (turn) end(turn, error);
    for (const entry of approvals.values()) entry.respond('cancel');
    closing = child?.pid && life ? life.stop().catch(() => {}) : Promise.resolve();
    return closing;
  }

  return {
    protocol: 'codex-app',
    start,
    prompt,
    steer,
    cancel,
    close,
    get alive() {
      return Boolean(child && peer && !peer.closed && !closing);
    },
    get pid() {
      return child?.pid ?? null;
    },
    get sessionId() {
      return threadId;
    },
    get stderr() {
      return stderr.text;
    },
  };
}
