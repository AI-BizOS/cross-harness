// Agent Client Protocol (https://agentclientprotocol.com), protocol version 1, over
// one long-lived agent process. A turn is a session/prompt request; session/update
// notifications become text, activity, plan and usage events; the agent's
// session/request_permission requests become approval events.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODES, fail } from '../protocol/errors.js';
import { JsonRpcPeer } from '../util/jsonrpc.js';
import { spawnAgent, lifecycle, tail } from '../util/process.js';
import { clip, oneLine } from '../util/text.js';
import {
  CLIENT_INFO,
  abortReason,
  assertMode,
  assertPrompt,
  jsonDetail,
  normalizeMcpServers,
  safeEmitter,
  textThrottle,
  within,
} from './common.js';

const INIT_MS = 30_000;
const SESSION_MS = 120_000;
const CONFIG_MS = 30_000;
const DRAIN_MS = 5_000;
const EXIT_GRACE_MS = 1_000;
const KINDS = { execute: 'command', edit: 'edit', delete: 'edit', move: 'edit', read: 'read', search: 'search', think: 'thinking', fetch: 'tool', other: 'tool' };
const STATUS = { pending: 'running', in_progress: 'running', completed: 'done', failed: 'failed' };
const CALL_FIELDS = ['kind', 'title', 'name', 'status', 'rawInput', 'locations', 'content'];
// Mode ids differ between agents; they are matched by id or name, in order of preference.
const MODE_PREFERENCE = {
  full: [/bypass/i, /yolo/i, /full/i, /auto/i],
  workspace: [/accept.?edits/i, /^default$/i, /default|normal|ask|manual/i],
  ask: [/^default$/i, /default|normal|ask|manual/i],
  plan: [/plan/i],
};
const AUTO_MODE = /yolo|auto|bypass|full|accept/i;
const cancelledOutcome = () => ({ outcome: { outcome: 'cancelled' } });

// Tool updates carry only what changed; each one is merged over what the turn knows.
function mergeCall(known = {}, update = {}) {
  const call = { ...known };
  for (const key of CALL_FIELDS) if (update[key] != null) call[key] = update[key];
  return call;
}

function detailOf(call) {
  const input = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {};
  const command = Array.isArray(input.command) ? input.command.join(' ') : input.command;
  const paths = [
    ...(Array.isArray(call.locations) ? call.locations : []),
    ...(Array.isArray(call.content) ? call.content.filter((item) => item?.type === 'diff') : []),
  ]
    .map((item) => item?.path)
    .filter((item) => typeof item === 'string');
  const value =
    typeof command === 'string'
      ? command
      : paths.length
        ? [...new Set(paths)].join(', ')
        : ['file_path', 'path', 'url', 'pattern', 'query'].map((key) => input[key]).find((item) => typeof item === 'string');
  return value ? oneLine(value, 300) : '';
}

// Every file a tool call names, so edits can be checked against the agent's directory.
function pathsOf(call) {
  const input = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {};
  return [
    ...(Array.isArray(call.locations) ? call.locations.map((item) => item?.path) : []),
    ...(Array.isArray(call.content) ? call.content.filter((item) => item?.type === 'diff').map((item) => item.path) : []),
    ...['file_path', 'filePath', 'path', 'notebook_path', 'destination', 'target'].map((key) => input[key]),
  ].filter((item, index, all) => typeof item === 'string' && item && all.indexOf(item) === index);
}

// Option ids differ between agents (allow-once, approve_once, once): choose by kind.
function permissionOutcome(options, decision) {
  const kinds =
    decision === 'allow_once'
      ? ['allow_once']
      : decision === 'allow_always'
        ? ['allow_always', 'allow_once']
        : decision === 'cancel'
          ? []
          : ['reject_once', 'reject_always'];
  const option = kinds.map((kind) => options.find((item) => item?.kind === kind)).find(Boolean);
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelledOutcome();
}

function flattenChoices(option) {
  return (Array.isArray(option?.options) ? option.options : [])
    .flatMap((item) => (Array.isArray(item?.options) ? item.options : [item]))
    .filter((item) => item?.value !== undefined);
}

function pickMode(modes, currentId, permissionMode) {
  const current = modes.find((item) => item.id === currentId);
  const wanted = MODE_PREFERENCE[permissionMode] || [];
  // Outside full mode, never stay in an auto-approving mode a resumed session left on.
  const mustLeave = permissionMode !== 'full' && current && AUTO_MODE.test(`${current.id} ${current.name}`);
  const target = wanted.map((pattern) => modes.find((item) => pattern.test(item.id) || pattern.test(item.name))).find(Boolean);
  if (!target) return null;
  if (target.id === currentId) return null;
  if (permissionMode === 'full' || permissionMode === 'plan' || mustLeave || permissionMode === 'workspace') return target.id;
  return null;
}

function modelValue(option, model) {
  const forms = (value) => {
    let parts;
    try {
      parts = JSON.parse(value);
    } catch {
      /* Not a JSON pair. */
    }
    parts = Array.isArray(parts) ? parts.map(String) : String(value).split('/');
    return [parts.join('/'), parts.at(-1)];
  };
  const items = flattenChoices(option);
  return (
    (items.find((item) => item.value === model) ||
      items.find((item) => forms(item.value).includes(model)) ||
      items.find((item) => String(item.name).toLowerCase() === model.toLowerCase()))?.value ?? model
  );
}

/**
 * @param {{binary:string, args?:string[], env?:NodeJS.ProcessEnv, cwd:string, label?:string, spawnProcess?:Function}} options
 */
export function createAcpSession({ binary, args = [], env, cwd, label = 'ACP agent', spawnProcess }) {
  let child = null;
  let peer = null;
  let life = null;
  let stderr = { text: '' };
  let exited = false;
  let closing = null;
  let sessionId = null;
  let capabilities = null;
  let emit = safeEmitter(null);
  let busy = false;
  let turn = null;
  let draining = null;
  let cancelling = false;
  const approvals = new Map();

  const cancelApprovals = () => {
    for (const stop of [...approvals.values()]) stop();
  };
  // Keep the agent's own words: they usually say how to fix the problem.
  const agentError = (error, code) => {
    if (error?.code !== CODES.RPC_ERROR) return error;
    if (error.rpcCode === -32000 || /auth/i.test(error.message)) {
      return fail(CODES.AUTH_REQUIRED, `${label} is not signed in. Sign in once in a terminal, then try again. (${clip(error.message, 200)})`, {
        rpcCode: error.rpcCode,
        method: error.method,
      });
    }
    return fail(code, `${label}: ${clip(error.message, 400)}`, { rpcCode: error.rpcCode, method: error.method });
  };

  function onNotification(method, params) {
    if (method !== 'session/update' || !sessionId || params?.sessionId !== sessionId) return;
    const update = params.update || {};
    const type = update.sessionUpdate;
    if (type === 'usage_update') {
      const { sessionUpdate, _meta, ...usage } = update;
      emit({ type: 'usage', usage });
      return;
    }
    // Outside a turn this is a session/load history replay or the tail of a cancelled turn.
    const t = turn;
    if (!t) return;
    if (type === 'agent_message_chunk') {
      if (update.content?.type !== 'text' || typeof update.content.text !== 'string') return;
      // Text after a tool call or from a new message starts a new paragraph.
      if (t.text && !t.text.endsWith('\n') && (t.split || (update.messageId && t.messageId && update.messageId !== t.messageId))) t.text += '\n\n';
      t.split = false;
      t.messageId = update.messageId || t.messageId;
      t.text += update.content.text;
      t.throttle.update(t.text);
    } else if (type === 'agent_thought_chunk') {
      if (!t.thinking) {
        t.thinking = true;
        emit({ type: 'activity', id: 'thinking', kind: 'thinking', title: 'Thinking', status: 'running' });
      }
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      if (update.toolCallId == null) return;
      const call = mergeCall(t.tools.get(update.toolCallId), update);
      t.tools.set(update.toolCallId, call);
      t.split = true;
      emit({
        type: 'activity',
        id: String(update.toolCallId),
        kind: KINDS[call.kind] || 'tool',
        title: oneLine(call.title || call.name || 'Tool call', 120),
        status: STATUS[call.status] || 'running',
        detail: detailOf(call),
      });
    } else if (type === 'plan') {
      emit({
        type: 'plan',
        entries: (Array.isArray(update.entries) ? update.entries : []).map((entry) => ({
          content: oneLine(entry?.content ?? '', 300),
          status: ['pending', 'in_progress', 'completed'].includes(entry?.status) ? entry.status : 'pending',
        })),
      });
    }
  }

  function onRequest(method, params) {
    if (method !== 'session/request_permission') {
      throw fail(CODES.RPC_UNSUPPORTED, `Troupe does not provide ${method}`, { rpcCode: -32601 });
    }
    // Once a turn is cancelled, ACP answers its permission requests as cancelled.
    if (cancelling || closing || !turn) return cancelledOutcome();
    const options = Array.isArray(params.options) ? params.options : [];
    const raw = params.toolCall || {};
    const call = mergeCall(turn.tools.get(raw.toolCallId), raw);
    const rawCommand = call.rawInput?.command;
    const command = Array.isArray(rawCommand) ? rawCommand.join(' ') : typeof rawCommand === 'string' ? rawCommand : undefined;
    const detail = detailOf(call) || jsonDetail(call.rawInput);
    const kind = ['edit', 'delete', 'move'].includes(call.kind)
      ? 'edit'
      : call.kind === 'execute' || command
        ? 'command'
        : call.kind === 'read'
          ? 'read'
          : call.kind === 'search'
            ? 'search'
            : 'tool';
    const id = randomUUID();
    return new Promise((resolve) => {
      const respond = (decision) => {
        if (!approvals.delete(id)) return false;
        resolve(permissionOutcome(options, decision));
        return true;
      };
      approvals.set(id, () => respond('cancel'));
      const sent = emit({
        type: 'approval',
        id,
        kind,
        title: oneLine(call.title || call.name || detail || 'Tool call', 160),
        detail,
        ...(command ? { command } : {}),
        ...(kind === 'edit' ? { paths: pathsOf(call) } : {}),
        options: ['allow_once', 'allow_always', 'deny'],
        respond,
      });
      if (!sent) respond('cancel');
    });
  }

  // Best effort: an agent that refuses a model or mode keeps its own choice.
  async function configure(response, { model, permissionMode }) {
    const attempt = (method, params) => peer.request(method, params, { timeoutMs: CONFIG_MS }).catch(() => null);
    const options = Array.isArray(response?.configOptions) ? response.configOptions : [];
    const option = (category) => options.find((item) => item && item.type !== 'boolean' && (item.category === category || item.id === category));
    const modelOption = option('model');
    if (typeof model === 'string' && model) {
      if (modelOption) {
        const value = modelValue(modelOption, model);
        if (value !== modelOption.currentValue) await attempt('session/set_config_option', { sessionId, configId: modelOption.id, value });
      } else if (Array.isArray(response?.models?.availableModels)) {
        const found = response.models.availableModels.find((item) => item?.modelId === model || String(item?.name).toLowerCase() === model.toLowerCase());
        if (found && found.modelId !== response.models.currentModelId) await attempt('session/set_model', { sessionId, modelId: found.modelId });
      }
    }
    const modes = response?.modes;
    const modeOption = option('mode');
    if (Array.isArray(modes?.availableModes)) {
      const list = modes.availableModes.map((item) => ({ id: item?.id, name: String(item?.name || '') }));
      const modeId = pickMode(list, modes.currentModeId, permissionMode);
      if (modeId) await attempt('session/set_mode', { sessionId, modeId });
    } else if (modeOption) {
      const list = flattenChoices(modeOption).map((item) => ({ id: item.value, name: String(item.name || '') }));
      const value = pickMode(list, modeOption.currentValue, permissionMode);
      if (value) await attempt('session/set_config_option', { sessionId, configId: modeOption.id, value });
    }
  }

  async function start({ sessionId: resumeId = null, model = null, permissionMode = 'ask', mcpServers = [], onEvent } = {}) {
    if (child) throw fail(CODES.START_FAILED, `${label} session already started`);
    assertMode(permissionMode);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail(CODES.START_FAILED, 'The working directory must be an absolute path');
    if (resumeId !== null && (typeof resumeId !== 'string' || !resumeId)) throw fail(CODES.SESSION_INVALID, 'Invalid session id');
    // ACP stdio servers always carry args and an env list of {name,value}.
    const servers = normalizeMcpServers(mcpServers).map((server) => ({
      name: server.name,
      command: server.command,
      args: server.args,
      env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
    }));
    emit = safeEmitter(onEvent);
    try {
      child = spawnAgent(binary, args, { cwd, env, spawnProcess });
    } catch (error) {
      throw fail(CODES.START_FAILED, `${label} failed to start: ${error.code || error.message}`);
    }
    life = lifecycle(child);
    stderr = tail(child.stderr);
    peer = new JsonRpcPeer({ input: child.stdout, output: child.stdin, jsonrpc: true, label, onNotification, onRequest });
    child.once('error', (error) => peer.close(fail(CODES.START_FAILED, `${label} failed to start: ${error.code || error.message}`)));
    // A descendant holding stderr open can delay 'close'; the session ends with the agent.
    child.once('exit', (code, signal) => {
      exited = true;
      const timer = setTimeout(() => {
        peer.close(fail(CODES.PROCESS_EXITED, `${label} exited (${signal || code})`, { exitCode: code, signal, stderr: stderr.text }));
        void close();
      }, EXIT_GRACE_MS);
      timer.unref?.();
    });
    try {
      capabilities = await peer.request(
        'initialize',
        { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: CLIENT_INFO },
        { timeoutMs: INIT_MS },
      );
      if (capabilities?.protocolVersion !== 1) throw fail(CODES.VERSION_UNSUPPORTED, `${label} speaks ACP version ${capabilities?.protocolVersion}, Troupe speaks 1`);
      const agent = capabilities.agentCapabilities || {};
      const base = { cwd, mcpServers: servers };
      const method = !resumeId ? null : agent.loadSession ? 'session/load' : agent.sessionCapabilities?.resume ? 'session/resume' : null;
      let response = null;
      let resumed = false;
      if (method) {
        try {
          response = await peer.request(method, { sessionId: resumeId, ...base }, { timeoutMs: SESSION_MS });
          resumed = true;
        } catch (error) {
          // A session the agent no longer has starts over; sign-in, timeout and exit still fail.
          if (error.code !== CODES.RPC_ERROR || error.rpcCode === -32000) throw error;
        }
      }
      if (resumed) sessionId = resumeId;
      else {
        response = await peer.request('session/new', base, { timeoutMs: SESSION_MS });
        if (typeof response?.sessionId !== 'string' || !response.sessionId) throw fail(CODES.SESSION_UNKNOWN, `${label} did not return a session id`);
        sessionId = response.sessionId;
      }
      await configure(response, { model, permissionMode });
      if (peer.closed) throw peer.closed;
      emit({ type: 'session', sessionId });
      return { sessionId, resumed };
    } catch (error) {
      void close();
      throw agentError(error, CODES.START_FAILED);
    }
  }

  async function prompt(text, { signal } = {}) {
    assertPrompt(text);
    if (busy) throw fail(CODES.BUSY, `${label} is still answering the previous message`);
    if (!peer || !sessionId) throw fail(CODES.CLOSED, `${label} session has not started`);
    if (peer.closed) throw peer.closed;
    busy = true;
    const t = { text: '', thinking: false, split: false, messageId: null, tools: new Map(), throttle: textThrottle(emit) };
    let fire;
    const aborted = new Promise((_, reject) => {
      fire = () => {
        if (turn === t) void cancel();
        reject(abortReason(signal, label));
      };
    });
    aborted.catch(() => {});
    signal?.addEventListener('abort', fire, { once: true });
    try {
      if (signal?.aborted) throw abortReason(signal, label);
      // A cancelled turn returns at once but the agent may still be winding it down.
      if (draining) await Promise.race([within(draining, DRAIN_MS), aborted]);
      cancelling = false;
      turn = t;
      const request = peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      const settled = request.then(() => {}, () => {});
      draining = settled;
      void settled.then(() => {
        if (draining === settled) draining = null;
      });
      const result = await Promise.race([request, aborted]);
      if (result?.stopReason === 'cancelled') throw fail(CODES.CANCELLED, `${label}: turn cancelled`);
      if (result?.stopReason === 'refusal') throw fail(CODES.PROVIDER_FAILED, `${label} refused this request`, { reason: 'refusal' });
      return { text: t.text, stopReason: result?.stopReason ?? null, usage: result?.usage ?? null };
    } catch (error) {
      throw agentError(error, CODES.PROVIDER_FAILED);
    } finally {
      signal?.removeEventListener('abort', fire);
      if (turn === t) turn = null;
      t.throttle.flush();
      cancelApprovals();
      busy = false;
    }
  }

  async function cancel() {
    cancelling = true;
    cancelApprovals();
    if (sessionId && peer && !peer.closed) {
      try {
        peer.notify('session/cancel', { sessionId });
        return true;
      } catch {
        /* The exit ends the turn by itself. */
      }
    }
    return false;
  }

  function close() {
    if (closing) return closing;
    if (!child || !life) return Promise.resolve();
    cancelApprovals();
    peer?.close(fail(CODES.CLOSED, `${label} session closed`));
    closing = life.stop().catch(() => {});
    return closing;
  }

  return {
    protocol: 'acp',
    start,
    prompt,
    cancel,
    close,
    // ACP has no way to add text to a running turn.
    steer: async () => false,
    get alive() {
      return Boolean(child && peer && !exited && !closing && !peer.closed);
    },
    get pid() {
      return child?.pid ?? null;
    },
    get sessionId() {
      return sessionId;
    },
    get capabilities() {
      return capabilities;
    },
    get stderr() {
      return stderr.text;
    },
  };
}
