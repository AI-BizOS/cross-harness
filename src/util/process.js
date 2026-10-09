// Child process helpers. Agents run in their own process group on POSIX so that
// stopping an agent also stops the commands it started (test runners, dev servers).
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Starts an agent process with piped stdio.
 * @param {string} binary
 * @param {string[]} args
 * @param {{cwd?:string, env?:NodeJS.ProcessEnv, spawnProcess?:typeof nodeSpawn}} options
 */
export function spawnAgent(binary, args, { cwd, env, spawnProcess = nodeSpawn } = {}) {
  return spawnProcess(binary, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !IS_WINDOWS,
    windowsHide: true,
  });
}

/** Keeps the last `limit` characters a stream wrote. */
export function tail(stream, limit = 8192) {
  const holder = { text: '' };
  stream?.on?.('data', (chunk) => {
    holder.text = (holder.text + chunk.toString()).slice(-limit);
  });
  return holder;
}

/**
 * Lifecycle for one child: whether it exited and how to stop it with its group.
 * `stop()` sends SIGTERM to the group, then SIGKILL after `graceMs`. Never rejects.
 */
export function lifecycle(child, { graceMs = 2000 } = {}) {
  let exited = child.exitCode !== null || child.signalCode !== null;
  const done = exited
    ? Promise.resolve()
    : new Promise((resolve) => {
        child.once('exit', () => {
          exited = true;
          resolve();
        });
        child.once('error', () => {
          if (child.pid === undefined) {
            exited = true;
            resolve();
          }
        });
      });
  let stopping = null;

  const groupAlive = () => {
    if (IS_WINDOWS || !child.pid) return !exited;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  };
  const signal = (name) => {
    if (!child.pid) return;
    if (IS_WINDOWS) {
      if (name === 'SIGKILL' || name === 'SIGTERM') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      }
      return;
    }
    try {
      process.kill(-child.pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        /* Already gone. */
      }
    }
  };
  const wait = (ms) =>
    new Promise((resolve) => {
      // stop() must finish even after the child was the last active handle.
      setTimeout(resolve, ms);
    });

  return {
    get exited() {
      return exited;
    },
    done,
    stop() {
      stopping ??= (async () => {
        if (!child.pid) return;
        try {
          child.stdin?.end();
        } catch {
          /* Already closed. */
        }
        if (!groupAlive()) return;
        signal('SIGTERM');
        const started = Date.now();
        // Commands the agent started share its group and may outlive the leader.
        while (Date.now() - started < graceMs) {
          if (exited && !groupAlive()) return;
          await wait(50);
        }
        if (groupAlive() || !exited) signal('SIGKILL');
        await Promise.race([done, wait(graceMs)]);
      })();
      return stopping;
    },
  };
}

/** Runs a short command and collects its output, with a hard timeout. */
export function runCommand(command, args, { cwd, env, timeoutMs = 10_000, input, maxBuffer = 4 * 1024 * 1024, spawnProcess = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WINDOWS, windowsHide: true });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', error });
      return;
    }
    const life = lifecycle(child, { graceMs: 1000 });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBuffer) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBuffer) stderr += chunk;
    });
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    const timer = setTimeout(() => {
      timedOut = true;
      void life.stop();
    }, timeoutMs);
    timer.unref?.();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...result });
    };
    child.once('error', (error) => finish({ code: null, signal: null, error }));
    child.once('close', (code, sig) => {
      // Whatever the command left running in its group (a server a test started) ends with it.
      if (!IS_WINDOWS && child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* Nothing left. */
        }
      }
      finish({ code, signal: sig });
    });
  });
}
