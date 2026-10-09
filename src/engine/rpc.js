// The engine protocol for user interfaces (spec/orchestration.md §Client protocol):
// newline-delimited JSON-RPC 2.0 over any byte stream. `troupe serve --stdio` exposes
// an engine this way, so `ssh host troupe serve --stdio` runs every agent on that host
// while the TUI or GUI stays local.
//
//   → initialize {client}                ← {protocol, version, snapshot}
//   → call {method, params}              ← result of engine.call(method, params)
//   ← notification "event" {event}       every engine event, in order
import { spawn } from 'node:child_process';
import { CODES, TroupeError, fail } from '../protocol/errors.js';
import { PROTOCOL_VERSION } from '../protocol/index.js';
import { JsonRpcPeer } from '../util/jsonrpc.js';
import { tail } from '../util/process.js';

/** An in-process client: the same interface user interfaces use for remote engines. */
export function localClient(engine) {
  return {
    remote: false,
    async call(method, params = {}) {
      return engine.call(method, params);
    },
    subscribe(listener) {
      return engine.subscribe(listener);
    },
    async close() {
      await engine.close();
    },
  };
}

/** Serves `engine` on a pair of streams until the input ends. */
export function serveEngine(engine, { input = process.stdin, output = process.stdout } = {}) {
  let unsubscribe = null;
  return new Promise((resolve) => {
    const peer = new JsonRpcPeer({
      input,
      output,
      jsonrpc: true,
      label: 'troupe client',
      onRequest: async (method, params) => {
        if (method === 'initialize') {
          unsubscribe?.();
          // Events start flowing right after the snapshot they follow.
          const snapshot = engine.snapshot();
          unsubscribe = engine.subscribe((event) => {
            try {
              peer.notify('event', { event });
            } catch {
              /* Client gone; the close handler cleans up. */
            }
          });
          return { protocol: PROTOCOL_VERSION, version: snapshot.version, snapshot };
        }
        if (method === 'call') {
          if (!params || typeof params.method !== 'string') throw fail(CODES.ARGUMENT_INVALID, 'call needs a method');
          try {
            const result = await engine.call(params.method, params.params || {});
            return result === undefined ? null : result;
          } catch (error) {
            throw Object.assign(error, { rpcCode: error.rpcCode || -32000 });
          }
        }
        throw fail(CODES.METHOD_UNKNOWN, `Unknown method: ${method}`, { rpcCode: -32601 });
      },
      onClose: () => {
        unsubscribe?.();
        resolve();
      },
    });
  });
}

function toTroupeError(error) {
  if (error instanceof TroupeError && error.code !== CODES.RPC_ERROR) return error;
  const code = error?.data?.code;
  return code ? new TroupeError(code, error.message) : error;
}

/**
 * Starts `command args` (for example `ssh host troupe serve --stdio --cwd ~/repo`) and
 * talks to the engine it serves.
 */
export async function connectRemote({ command, args = [], env = process.env, label = 'remote troupe', spawnProcess = spawn, timeoutMs = 60_000 }) {
  const child = spawnProcess(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stderr = tail(child.stderr, 4000);
  const listeners = new Set();
  let closed = false;
  const peer = new JsonRpcPeer({
    input: child.stdout,
    output: child.stdin,
    jsonrpc: true,
    label,
    onNotification: (method, params) => {
      if (method !== 'event' || !params?.event) return;
      for (const listener of [...listeners]) {
        try {
          listener(params.event);
        } catch {
          /* A UI error must not drop the connection. */
        }
      }
    },
  });
  child.once('error', (error) => peer.close(fail(CODES.START_FAILED, `${label} failed to start: ${error.message}`)));
  child.once('exit', (code) => {
    peer.close(fail(CODES.CLOSED, `${label} exited (${code})${stderr.text ? `: ${stderr.text.trim().split('\n').slice(-3).join(' ')}` : ''}`));
  });
  let hello;
  try {
    hello = await peer.request('initialize', { client: 'troupe' }, { timeoutMs });
  } catch (error) {
    child.kill();
    throw fail(error.code === CODES.TIMEOUT ? CODES.TIMEOUT : CODES.START_FAILED, `${label}: ${error.message}${stderr.text ? ` (${stderr.text.trim().split('\n').pop()})` : ''}`);
  }
  if (hello?.protocol !== PROTOCOL_VERSION) {
    child.kill();
    throw fail(CODES.VERSION_UNSUPPORTED, `${label} speaks ${hello?.protocol}, this Troupe speaks ${PROTOCOL_VERSION}; install the same version on both machines`);
  }
  return {
    remote: true,
    initial: hello.snapshot,
    async call(method, params = {}) {
      if (closed) throw fail(CODES.CLOSED, `${label} is closed`);
      try {
        return await peer.request('call', { method, params });
      } catch (error) {
        throw toTroupeError(error);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      try {
        child.stdin.end();
      } catch {
        /* Already closed. */
      }
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          resolve();
        }, 5000);
        timer.unref?.();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    onClose(callback) {
      child.once('exit', callback);
    },
  };
}

/** argv for running Troupe on another machine over SSH. */
export function sshCommand(host, { cwd = null, remoteCommand = 'troupe', sshArgs = [] } = {}) {
  // ssh would read a "host" starting with "-" as an option (for example -oProxyCommand=…).
  if (typeof host !== 'string' || !host.trim() || host.startsWith('-')) throw fail(CODES.ARGUMENT_INVALID, `Invalid SSH host: ${host}`);
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const remote = [remoteCommand, 'serve', '--stdio', ...(cwd ? ['--cwd', quote(cwd)] : [])].join(' ');
  return { command: 'ssh', args: [...sshArgs, '-T', '-o', 'BatchMode=yes', host, remote] };
}
