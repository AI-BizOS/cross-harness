// Claude Code in headless stream-json mode, kept alive across turns. stream-json is
// not JSON-RPC: each stdout line is a typed message, one `user` line on stdin starts
// a turn and exactly one `result` line ends it. With --permission-prompt-tool stdio,
// every tool the CLI would ask about arrives as a `can_use_tool` control request.
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { CODES, fail } from '../protocol/errors.js';
import { spawnAgent, lifecycle, tail } from '../util/process.js';
import { clip } from '../util/text.js';
import { TEXT_INTERVAL_MS, abortReason, assertMode, assertPrompt, jsonDetail, normalizeMcpServers, safeEmitter, subjectOf } from './common.js';

const MAX_LINE = 64 * 1024 * 1024;
const INTERRUPT_WAIT_MS = 5_000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{9,99}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+#[\]-]{0,127}$/;
const KINDS = { Bash: 'command', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Read: 'read', Grep: 'search', Glob: 'search', WebSearch: 'search', WebFetch: 'tool' };
const DENIED = 'The user denied this action.';
const STOPPED = 'The user stopped this turn.';

const blockText = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('') : '';

function describe(name, input) {
  const tool = typeof name === 'string' && name ? name : 'tool';
  const args = input && typeof input === 'object' ? input : {};
  const subject = subjectOf(args);
  const command = typeof args.command === 'string' ? args.command : undefined;
  const kind = KINDS[tool] || 'tool';
  const paths = [args.file_path, args.notebook_path].filter((value) => typeof value === 'string' && value);
  return {
    kind,
    title: subject ? `${tool}: ${subject}` : tool,
    detail: command ? clip(command, 4000) : jsonDetail(args),
    ...(command ? { command } : {}),
    ...(kind === 'edit' ? { paths } : {}),
  };
}

/** --mcp-config takes inline JSON. */
export function mcpConfig(servers) {
  const list = normalizeMcpServers(servers);
  if (!list.length) return null;
  return JSON.stringify({ mcpServers: Object.fromEntries(list.map(({ name, command, args, env }) => [name, { type: 'stdio', command, args, env }])) });
}

export function createClaudeSession({ binary, args = [], env, cwd, label = 'Claude Code', spawnProcess, strictMcp = false }) {
  let child = null;
  let life = null;
  let stderr = { text: '' };
  let sessionId = null;
  let started = false;
  let exitError = null;
  let closing = null;
  let current = null;
  let waiting = false;
  let seq = 0;
  let buffer = '';
  let skipLine = false;
  let emit = safeEmitter(null);
  const approvals = new Map();
  const controls = new Map();

  const alive = () => Boolean(child) && started && !exitError && !closing;

  function write(message) {
    if (exitError) throw exitError;
    if (closing) throw fail(CODES.CLOSED, `${label} session closed`);
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  function feed(text) {
    buffer += text;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (skipLine) {
        skipLine = false;
        continue;
      }
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message && typeof message === 'object') {
        try {
          dispatch(message);
        } catch {
          /* One odd message cannot end the session. */
        }
      }
    }
    if (buffer.length > MAX_LINE) {
      buffer = '';
      skipLine = true;
    }
  }

  function dispatch(message) {
    const turn = current && !current.settled ? current : null;
    if (message.type === 'system') {
      if (message.subtype === 'init') adopt(message.session_id);
    } else if (message.type === 'assistant') {
      if (turn) onAssistant(turn, message);
    } else if (message.type === 'user') {
      if (turn) onToolResults(turn, message);
    } else if (message.type === 'result') onResult(message);
    else if (message.type === 'control_request') onControlRequest(message);
    else if (message.type === 'control_response') {
      const response = message.response || {};
      controls.get(response.request_id)?.(response.subtype === 'success');
    } else if (message.type === 'control_cancel_request') {
      // The CLI withdrew a permission prompt (its turn ended): never answer it late.
      approvals.delete(message.request_id);
    }
  }

  function adopt(id) {
    if (typeof id === 'string' && SESSION_ID.test(id) && id !== sessionId) {
      sessionId = id;
      emit({ type: 'session', sessionId: id });
    }
  }

  function showText(turn) {
    const wait = turn.shownAt + TEXT_INTERVAL_MS - Date.now();
    if (wait > 0) {
      turn.timer ??= setTimeout(() => {
        turn.timer = null;
        if (!turn.settled) showText(turn);
      }, wait);
      turn.timer.unref?.();
      return;
    }
    turn.shownAt = Date.now();
    turn.shown = turn.text;
    emit({ type: 'text', text: turn.text });
  }

  function onAssistant(turn, message) {
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    let text = '';
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
      else if (block?.type === 'tool_use' && typeof block.id === 'string') {
        const row = { id: block.id, ...describe(block.name, block.input) };
        turn.tools.set(block.id, row);
        emit({ type: 'activity', id: row.id, kind: row.kind, title: row.title, status: 'running', detail: row.detail });
      } else if ((block?.type === 'thinking' || block?.type === 'redacted_thinking') && !turn.thought) {
        turn.thought = true;
        emit({ type: 'activity', id: `thinking-${turn.id}`, kind: 'thinking', title: 'Thinking', status: 'done' });
      }
    }
    // Sub-agent messages carry parent_tool_use_id; only the main thread's text is the answer.
    if (!text || message.parent_tool_use_id) return;
    // One API message arrives as one line per content block; blocks share its id. A new
    // message replaces the shown text: the answer is the turn's last message, earlier
    // ones are commentary between tool calls (shown as activity instead).
    const id = message.message?.id || null;
    turn.text = id && id === turn.textId ? turn.text + text : text;
    turn.textId = id;
    showText(turn);
  }

  function onToolResults(turn, message) {
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    for (const block of content) {
      const row = block?.type === 'tool_result' ? turn.tools.get(block.tool_use_id) : null;
      if (!row) continue;
      const failed = block.is_error === true;
      turn.tools.delete(block.tool_use_id);
      emit({ type: 'activity', id: row.id, kind: row.kind, title: row.title, status: failed ? 'failed' : 'done', ...(failed ? { detail: clip(blockText(block.content) || row.detail, 4000) } : {}) });
    }
  }

  function onResult(message) {
    adopt(message.session_id);
    if (message.usage && typeof message.usage === 'object') emit({ type: 'usage', usage: message.usage });
    const turn = current;
    if (!turn) return;
    if (turn.interrupted) return end(turn, fail(CODES.CANCELLED, `${label}: turn cancelled`));
    if (message.is_error || message.subtype !== 'success') {
      const reason =
        [typeof message.result === 'string' ? message.result : '', ...(Array.isArray(message.errors) ? message.errors.map(String) : [])].filter(Boolean).join('; ') ||
        message.subtype ||
        'unknown error';
      const code = /login|auth|api key|credit/i.test(reason) ? CODES.AUTH_REQUIRED : CODES.PROVIDER_FAILED;
      return end(turn, fail(code, clip(`${label} failed: ${reason}`, 400), { reason: message.subtype }));
    }
    end(turn, null, {
      // The final answer is the last assistant message; `result` repeats it.
      text: typeof message.result === 'string' && message.result.trim() ? message.result : turn.text,
      stopReason: 'end_turn',
      usage: message.usage || null,
    });
  }

  function onControlRequest(message) {
    const id = message.request_id;
    const request = message.request || {};
    if (typeof id !== 'string' && typeof id !== 'number') return;
    const reply = (response) => {
      if (!alive()) return false;
      write({ type: 'control_response', response });
      return true;
    };
    if (request.subtype !== 'can_use_tool') {
      reply({ subtype: 'error', request_id: id, error: `Troupe does not handle ${request.subtype}` });
      return;
    }
    const input = request.input && typeof request.input === 'object' ? request.input : {};
    const answer = (choice) => {
      if (!approvals.delete(id)) return false;
      if (choice === 'cancel' && current) current.interrupted = true;
      // Anything but an explicit allow is a deny, so an unknown choice fails closed.
      if (choice === 'allow_once' || choice === 'allow_always') return reply({ subtype: 'success', request_id: id, response: { behavior: 'allow', updatedInput: input } });
      return reply({ subtype: 'success', request_id: id, response: { behavior: 'deny', message: choice === 'cancel' ? STOPPED : DENIED, interrupt: choice === 'cancel' } });
    };
    approvals.set(id, answer);
    const turn = current;
    // Nobody waits on a cancelled or abandoned turn: stop it instead of asking.
    if (!turn || turn.settled || turn.interrupted) {
      answer('cancel');
      return;
    }
    const sent = emit({ type: 'approval', id: String(id), ...describe(request.tool_name, input), options: ['allow_once', 'allow_always', 'deny'], respond: (choice) => answer(choice) });
    if (!sent) answer('cancel');
  }

  function end(turn, error, value) {
    if (current === turn) {
      current = null;
      approvals.clear();
    }
    clearTimeout(turn.timer);
    turn.timer = null;
    if (!turn.settled) {
      if (!error && value.text) emit({ type: 'text', text: value.text });
      else if (error && turn.text && turn.text !== turn.shown) emit({ type: 'text', text: turn.text });
      settle(turn, error, value);
    }
    turn.finished();
  }

  function settle(turn, error, value) {
    if (turn.settled) return;
    turn.settled = true;
    turn.cleanup();
    if (error) turn.reject(error);
    else turn.resolve(value);
  }

  function exited(error) {
    if (exitError) return;
    exitError = Object.assign(error, { stderr: stderr.text });
    approvals.clear();
    for (const done of [...controls.values()]) done(false);
    if (current) end(current, exitError);
  }

  async function start({ sessionId: resumeId = null, model = null, permissionMode = 'ask', mcpServers = [], onEvent } = {}) {
    if (child || closing) throw fail(CODES.START_FAILED, `${label} session already started or closed`);
    assertMode(permissionMode);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail(CODES.START_FAILED, 'The working directory must be an absolute path');
    // Both values follow options in argv: an option-shaped value would be read as a flag.
    if (resumeId !== null && !(typeof resumeId === 'string' && SESSION_ID.test(resumeId))) throw fail(CODES.SESSION_INVALID, 'Invalid session id');
    if (model !== null && !(typeof model === 'string' && MODEL.test(model))) throw fail(CODES.ARGUMENT_INVALID, 'Invalid model id');
    const mcp = mcpConfig(mcpServers);
    const argv = [
      ...args,
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      permissionMode === 'plan' ? 'plan' : 'default',
      ...(mcp ? ['--mcp-config', mcp, ...(strictMcp ? ['--strict-mcp-config'] : [])] : []),
      ...(model ? ['--model', model] : []),
      ...(resumeId ? ['--resume', resumeId] : []),
    ];
    emit = safeEmitter(onEvent);
    sessionId = resumeId;
    try {
      child = spawnAgent(binary, argv, { cwd, env, spawnProcess });
    } catch (error) {
      throw fail(CODES.START_FAILED, `${label} failed to start: ${error.code || error.message}`);
    }
    life = lifecycle(child);
    stderr = tail(child.stderr);
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk) => feed(decoder.write(chunk)));
    child.stdin.on('error', () => {
      /* close reports the exit. */
    });
    child.once('error', (error) => {
      if (!started) exited(fail(CODES.START_FAILED, `${label} failed to start: ${error.code || error.message}`));
    });
    child.once('close', (code, signal) => {
      feed(decoder.end() + '\n');
      exited(closing ? fail(CODES.CLOSED, `${label} session closed`) : fail(CODES.PROCESS_EXITED, `${label} exited (${signal || code})`, { exitCode: code, signal }));
    });
    // ENOENT/EACCES arrive before the next macrotask. system/init is not awaited: some
    // versions print it only after the first user message.
    await new Promise((resolve) => setImmediate(resolve));
    if (exitError) throw exitError.code === CODES.START_FAILED ? exitError : fail(CODES.START_FAILED, `${label} exited right after starting`, { stderr: stderr.text });
    started = true;
    return { sessionId, resumed: Boolean(resumeId) };
  }

  async function prompt(text, { signal } = {}) {
    assertPrompt(text);
    if (exitError) throw exitError;
    if (!alive()) throw fail(CODES.CLOSED, closing ? `${label} session closed` : `${label} session has not started`);
    if (waiting || (current && !current.settled)) throw fail(CODES.BUSY, `${label} is still answering the previous message`);
    if (signal?.aborted) throw abortReason(signal, label);
    // An abandoned turn still owes its result line; wait so it is not read as this turn's.
    if (current) {
      const ended = current.ended;
      waiting = true;
      try {
        await new Promise((resolve) => {
          ended.then(resolve);
          signal?.addEventListener('abort', resolve, { once: true });
        });
      } finally {
        waiting = false;
      }
    }
    if (exitError) throw exitError;
    if (signal?.aborted) throw abortReason(signal, label);
    return new Promise((resolve, reject) => {
      const abort = () => {
        turn.interrupted = true;
        settle(turn, abortReason(signal, label));
        cancel().catch(() => {});
      };
      const turn = {
        id: ++seq,
        text: '',
        textId: null,
        shown: '',
        shownAt: 0,
        timer: null,
        tools: new Map(),
        thought: false,
        interrupted: false,
        settled: false,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', abort),
      };
      turn.ended = new Promise((done) => (turn.finished = done));
      current = turn;
      signal?.addEventListener('abort', abort, { once: true });
      try {
        write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
      } catch (error) {
        end(turn, error);
      }
    });
  }

  // Stops the running turn; prompt() rejects CANCELLED once the CLI's result arrives.
  async function cancel() {
    if (!alive()) return false;
    if (current) current.interrupted = true;
    for (const answer of [...approvals.values()]) answer('cancel');
    const id = `troupe-interrupt-${++seq}`;
    return new Promise((resolve) => {
      let timer = null;
      const done = (ok) => {
        clearTimeout(timer);
        controls.delete(id);
        resolve(ok);
      };
      timer = setTimeout(() => done(false), INTERRUPT_WAIT_MS);
      timer.unref?.();
      controls.set(id, done);
      try {
        write({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });
      } catch {
        done(false);
      }
    });
  }

  function close() {
    if (closing) return closing;
    approvals.clear();
    if (!child || !life) {
      closing = Promise.resolve();
      return closing;
    }
    closing = life.stop().catch(() => {});
    return closing;
  }

  return {
    protocol: 'claude-stream',
    start,
    prompt,
    cancel,
    close,
    // stream-json input has no way to add text to a running turn.
    steer: async () => false,
    get alive() {
      return alive();
    },
    get pid() {
      return child?.pid ?? null;
    },
    get sessionId() {
      return sessionId;
    },
    get stderr() {
      return stderr.text;
    },
  };
}
