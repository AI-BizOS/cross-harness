// Newline-delimited JSON-RPC over any pair of byte streams. Used for ACP, MCP and
// `codex app-server` (which omits the "jsonrpc" member) on agent stdio, and for the
// engine's own remote protocol (`troupe serve --stdio`). Both sides may send requests.
import { StringDecoder } from 'node:string_decoder';
import { CODES, fail } from '../protocol/errors.js';

const MAX_LINE = 64 * 1024 * 1024;

export class JsonRpcPeer {
  /**
   * @param {object} options
   * @param {import('node:stream').Readable} options.input
   * @param {import('node:stream').Writable} options.output
   * @param {boolean} [options.jsonrpc=true] add "jsonrpc":"2.0" to messages we send
   * @param {string} [options.label]
   * @param {(method:string, params:any, id:any)=>any} [options.onRequest]
   * @param {(method:string, params:any)=>void} [options.onNotification]
   * @param {(error:Error)=>void} [options.onClose]
   * @param {(kind:string, detail:string)=>void} [options.log]
   */
  constructor({ input, output, jsonrpc = true, label = 'peer', onRequest = null, onNotification = () => {}, onClose = () => {}, log = null }) {
    this.input = input;
    this.output = output;
    this.jsonrpc = jsonrpc;
    this.label = label;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.onClose = onClose;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = null;
    this.buffer = '';
    this.skipping = false;
    const decoder = new StringDecoder('utf8');
    this.onData = (chunk) => this.feed(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    this.onEnd = () => this.close(fail(CODES.CLOSED, `${label} closed its output`));
    input.on('data', this.onData);
    input.once('end', this.onEnd);
    input.once('error', (error) => this.close(fail(CODES.CLOSED, `${label} stream failed: ${error.message}`)));
    output.on?.('error', () => {
      /* The read side reports the end of the conversation. */
    });
  }

  feed(text) {
    this.buffer += text;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      if (line) this.receiveLine(line);
    }
    if (this.buffer.length > MAX_LINE) {
      // Drop an oversized message up to its newline instead of buffering without bound.
      this.buffer = '';
      this.skipping = true;
      this.log?.('oversized', `${this.label} sent a line over ${MAX_LINE} bytes`);
    }
  }

  receiveLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log?.('non-json', line.slice(0, 200));
      return;
    }
    const items = Array.isArray(message) ? message : [message];
    for (const item of items) if (item && typeof item === 'object') this.dispatch(item);
  }

  dispatch(message) {
    const hasId = Object.hasOwn(message, 'id') && message.id !== null && message.id !== undefined;
    if (hasId && typeof message.method === 'string') {
      void this.answer(message);
      return;
    }
    if (hasId) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = fail(CODES.RPC_ERROR, String(message.error.message || `${this.label} request failed`), {
          rpcCode: message.error.code,
          method: waiter.method,
        });
        if (message.error.data !== undefined) error.data = message.error.data;
        waiter.reject(error);
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      try {
        this.onNotification(message.method, message.params ?? {});
      } catch (error) {
        this.log?.('notification-handler', error.message);
      }
    }
  }

  async answer(message) {
    let result;
    let error;
    try {
      if (!this.onRequest) throw fail(CODES.RPC_UNSUPPORTED, `Method not found: ${message.method}`, { rpcCode: -32601 });
      result = await this.onRequest(message.method, message.params ?? {}, message.id);
    } catch (cause) {
      error = cause;
    }
    if (this.closed) return;
    const reply = error
      ? {
          id: message.id,
          error: {
            code: Number.isInteger(error.rpcCode) ? error.rpcCode : -32603,
            message: String(error.message || 'error').slice(0, 2000),
            ...(error.code ? { data: { code: error.code } } : {}),
          },
        }
      : { id: message.id, result: result === undefined ? null : result };
    try {
      this.write(reply);
    } catch {
      /* Closed meanwhile. */
    }
  }

  write(message) {
    if (this.closed) throw this.closed;
    this.output.write(JSON.stringify(this.jsonrpc ? { jsonrpc: '2.0', ...message } : message) + '\n');
  }

  /**
   * @param {string} method
   * @param {any} [params]
   * @param {{timeoutMs?:number, signal?:AbortSignal}} [options]
   */
  request(method, params, { timeoutMs = 0, signal } = {}) {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      const finish = (fn) => (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => {
        this.pending.delete(id);
        finish(reject)(signal.reason instanceof Error ? signal.reason : fail(CODES.CANCELLED, 'Request cancelled'));
      };
      this.pending.set(id, { method, resolve: finish(resolve), reject: finish(reject) });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          finish(reject)(fail(CODES.TIMEOUT, `${this.label} did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`, { method }));
        }, timeoutMs);
        timer.unref?.();
      }
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.pending.delete(id);
        finish(reject)(error);
      }
    });
  }

  notify(method, params) {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  close(error = fail(CODES.CLOSED, `${this.label} closed`)) {
    if (this.closed) return;
    this.closed = error;
    this.input.off?.('data', this.onData);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    try {
      this.onClose(error);
    } catch {
      /* Listener failures do not matter at shutdown. */
    }
  }
}
