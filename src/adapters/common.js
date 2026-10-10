// Pieces shared by the session adapters. Each adapter turns one vendor protocol
// into the troupe/1 agent-session events (spec/agent-session.md).
import path from 'node:path';
import { CODES, fail } from '../protocol/errors.js';
import { PERMISSION_MODES } from '../protocol/index.js';
import { clip, oneLine } from '../util/text.js';

export const TEXT_INTERVAL_MS = 75;
export const CLIENT_INFO = Object.freeze({ name: 'troupe', title: 'Troupe', version: '0.1.1' });

/** Wraps a listener so a failing UI can never break a vendor turn. */
export function safeEmitter(listener) {
  const fn = typeof listener === 'function' ? listener : () => {};
  return (event) => {
    try {
      fn(event);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Emits answer snapshots at most every TEXT_INTERVAL_MS; `flush()` sends the
 * latest text immediately (used when a turn ends).
 */
export function textThrottle(emit) {
  let timer = null;
  let sentAt = 0;
  let latest = '';
  let sent = null;
  const push = () => {
    clearTimeout(timer);
    timer = null;
    sentAt = Date.now();
    if (latest !== sent) {
      sent = latest;
      emit({ type: 'text', text: latest });
    }
  };
  return {
    update(text) {
      latest = text;
      if (timer) return;
      const wait = TEXT_INTERVAL_MS - (Date.now() - sentAt);
      if (wait <= 0) push();
      else {
        timer = setTimeout(push, wait);
        timer.unref?.();
      }
    },
    flush() {
      if (latest) push();
      else clearTimeout(timer);
    },
    cancel() {
      clearTimeout(timer);
      timer = null;
    },
    get text() {
      return latest;
    },
  };
}

export function assertMode(mode) {
  if (!PERMISSION_MODES.includes(mode)) throw fail(CODES.PERMISSION_INVALID, `Unknown permission mode: ${mode}`);
  return mode;
}

export function assertPrompt(text, max = 200_000) {
  if (typeof text !== 'string' || !text.trim()) throw fail(CODES.PROMPT_INVALID, 'The message is empty');
  if (text.length > max) throw fail(CODES.PROMPT_INVALID, `The message is longer than ${max} characters`);
  return text;
}

/**
 * Validates MCP stdio server descriptors: a name, an absolute command, string
 * args and string env values. Returns normalised copies.
 * @param {{name:string, command:string, args?:string[], env?:Record<string,string>}[]} servers
 */
export function normalizeMcpServers(servers = []) {
  if (!Array.isArray(servers)) throw fail(CODES.MCP_INVALID, 'mcpServers must be a list');
  const names = new Set();
  return servers.map((server) => {
    const { name, command, args = [], env = {} } = server || {};
    const ok =
      typeof name === 'string' &&
      /^[A-Za-z0-9_-]{1,40}$/.test(name) &&
      !names.has(name) &&
      typeof command === 'string' &&
      path.isAbsolute(command) &&
      Array.isArray(args) &&
      args.every((arg) => typeof arg === 'string' && !arg.includes('\0')) &&
      env &&
      typeof env === 'object' &&
      Object.entries(env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0'));
    if (!ok) throw fail(CODES.MCP_INVALID, `Invalid MCP server descriptor: ${clip(String(name ?? '?'), 40)}`);
    names.add(name);
    return { name, command, args: [...args], env: { ...env } };
  });
}

/** A one-line summary of a tool's subject: its command, else paths, else main argument. */
export function subjectOf(input) {
  const args = input && typeof input === 'object' ? input : {};
  const command = Array.isArray(args.command) ? args.command.join(' ') : args.command;
  const value = [command, args.file_path, args.notebook_path, args.path, args.pattern, args.query, args.url].find(
    (item) => typeof item === 'string' && item.trim(),
  );
  return value ? oneLine(value.split('\n')[0], 160) : '';
}

export function jsonDetail(value, max = 4000) {
  if (value === undefined) return '';
  try {
    return clip(typeof value === 'string' ? value : JSON.stringify(value), max);
  } catch {
    return '';
  }
}

export function abortReason(signal, label) {
  return signal?.reason instanceof Error && signal.reason.name !== 'AbortError'
    ? signal.reason
    : fail(CODES.CANCELLED, `${label}: turn cancelled`);
}

export const delay = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/** Resolves when `promise` settles or after `ms`, whichever is first. */
export function within(promise, ms) {
  return Promise.race([promise.then(() => {}, () => {}), delay(ms)]);
}
