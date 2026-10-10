// Harnesses without a session protocol: one process per prompt, stdout is the answer.
// The argv comes from the provider definition, with {prompt} and {model} filled in.
// These CLIs act on their own, so the registry only allows them in full mode unless
// a definition maps the other modes to flags.
import path from 'node:path';
import { CODES, fail } from '../protocol/errors.js';
import { spawnAgent, lifecycle, tail } from '../util/process.js';
import { abortReason, assertMode, assertPrompt, safeEmitter, textThrottle } from './common.js';

const MAX_OUTPUT = 512 * 1024;

function fill(template, values) {
  return template.flatMap((item) => {
    if (typeof item !== 'string') return [];
    if (item === '{prompt}') return [values.prompt];
    if (item === '{model}') return values.model ? [values.model] : [];
    return [item];
  });
}

/**
 * @param {{binary:string, args?:string[], env?:NodeJS.ProcessEnv, cwd:string, label?:string, exec:{args:string[], modelArgs?:string[], modeArgs?:Record<string,string[]>}, spawnProcess?:Function}} options
 */
export function createExecSession({ binary, args = [], env, cwd, label = 'Agent', exec, spawnProcess }) {
  let emit = safeEmitter(null);
  let mode = 'full';
  let model = null;
  let running = null;
  let closed = false;
  let stderrText = '';

  async function start({ model: chosen = null, permissionMode = 'full', onEvent } = {}) {
    assertMode(permissionMode);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail(CODES.START_FAILED, 'The working directory must be an absolute path');
    if (!exec || !Array.isArray(exec.args) || !exec.args.includes('{prompt}')) throw fail(CODES.START_FAILED, `${label} has no exec argument template`);
    if (permissionMode !== 'full' && !exec.modeArgs?.[permissionMode]) {
      throw fail(CODES.PLAN_DENIED, `${label} runs tools without asking, so cross-harness only starts it in full mode`);
    }
    emit = safeEmitter(onEvent);
    mode = permissionMode;
    model = chosen;
    return { sessionId: null, resumed: false };
  }

  async function prompt(text, { signal } = {}) {
    assertPrompt(text);
    if (closed) throw fail(CODES.CLOSED, `${label} session closed`);
    if (running) throw fail(CODES.BUSY, `${label} is still answering the previous message`);
    if (signal?.aborted) throw abortReason(signal, label);
    const argv = [
      ...args,
      ...(model && exec.modelArgs ? fill(exec.modelArgs, { model }) : []),
      ...(exec.modeArgs?.[mode] || []),
      ...fill(exec.args, { prompt: text, model }),
    ];
    let child;
    try {
      child = spawnAgent(binary, argv, { cwd, env, spawnProcess });
    } catch (error) {
      throw fail(CODES.START_FAILED, `${label} failed to start: ${error.code || error.message}`);
    }
    child.stdin.end();
    const life = lifecycle(child);
    const err = tail(child.stderr);
    const throttle = textThrottle(emit);
    let output = '';
    emit({ type: 'activity', id: 'exec', kind: 'tool', title: `${label} is working`, status: 'running' });
    child.stdout.on('data', (chunk) => {
      if (output.length >= MAX_OUTPUT) return;
      output += chunk.toString();
      throttle.update(output.trim());
    });
    running = { child, life };
    const onAbort = () => void life.stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const [code, sig] = await new Promise((resolve) => {
        child.once('error', (error) => resolve([null, error.code || 'error']));
        child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      });
      stderrText = err.text;
      throttle.flush();
      if (signal?.aborted) throw abortReason(signal, label);
      if (closed) throw fail(CODES.CLOSED, `${label} session closed`);
      if (code !== 0) {
        emit({ type: 'activity', id: 'exec', kind: 'tool', title: `${label} is working`, status: 'failed' });
        throw fail(CODES.PROVIDER_FAILED, `${label} exited with ${sig || code}${err.text ? `: ${err.text.trim().split('\n').slice(-3).join(' ')}` : ''}`, {
          exitCode: code,
          signal: sig,
          stderr: err.text,
        });
      }
      emit({ type: 'activity', id: 'exec', kind: 'tool', title: `${label} is working`, status: 'done' });
      return { text: output.trim(), stopReason: 'end_turn', usage: null };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      running = null;
    }
  }

  async function cancel() {
    if (!running) return false;
    await running.life.stop();
    return true;
  }

  async function close() {
    closed = true;
    if (running) await running.life.stop();
  }

  return {
    protocol: 'exec',
    start,
    prompt,
    cancel,
    close,
    steer: async () => false,
    get alive() {
      return !closed;
    },
    get pid() {
      return running?.child?.pid ?? null;
    },
    get sessionId() {
      return null;
    },
    get stderr() {
      return stderrText;
    },
  };
}
