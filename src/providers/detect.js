// Finds installed harnesses and their versions. Results are cached briefly and
// concurrent checks share one probe, so opening a picker never re-runs every CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../util/process.js';

const IS_WINDOWS = process.platform === 'win32';
const TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;

function extraDirs(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const dirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.volta', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  if (IS_WINDOWS && env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
  return dirs;
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (IS_WINDOWS) return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of `command`, searching PATH and common install directories. */
export function resolveExecutable(command, env = process.env) {
  if (!command) return null;
  if (path.isAbsolute(command)) return isExecutable(command) ? command : null;
  if (command.includes('/') || command.includes('\\')) return null;
  const exts = IS_WINDOWS ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const dirs = [...(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean), ...extraDirs(env)];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export function parseVersion(text) {
  const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(String(text || ''));
  return match ? match[1] : null;
}

/**
 * @param {{registry:Record<string,object>, env?:NodeJS.ProcessEnv, probe?:Function, now?:()=>number}} options
 */
export function createDetector({ registry, env = process.env, probe = runCommand, now = Date.now }) {
  const cache = new Map();
  const inflight = new Map();

  async function check(provider) {
    const binary = resolveExecutable(provider.command, env);
    const base = {
      id: provider.id,
      name: provider.name,
      vendor: provider.vendor || '',
      protocol: provider.protocol,
      verified: Boolean(provider.verified),
      writes: provider.writes !== false,
      modes: provider.modes || ['plan', 'ask', 'workspace', 'full'],
      custom: Boolean(provider.custom),
    };
    if (!binary) {
      return { ...base, available: false, binary: null, version: null, reason: 'not-installed', fix: provider.install || `Install ${provider.name} and make sure \`${provider.command}\` is on PATH` };
    }
    const result = await probe(binary, provider.versionArgs || ['--version'], { env, timeoutMs: PROBE_TIMEOUT_MS });
    const version = parseVersion(`${result.stdout}\n${result.stderr}`);
    if (result.timedOut) return { ...base, available: false, binary, version: null, reason: 'probe-timeout', fix: `\`${provider.command} --version\` did not answer within 10 seconds` };
    if (result.error || (result.code !== 0 && !version)) {
      return { ...base, available: false, binary, version: null, reason: 'probe-failed', fix: `\`${provider.command} --version\` failed: ${String(result.stderr || result.error?.message || result.code).trim().split('\n').pop()}` };
    }
    return { ...base, available: true, binary, version, reason: null, fix: null, signIn: provider.signIn || null };
  }

  async function detect(id, { refresh = false } = {}) {
    const provider = registry[id];
    if (!provider) return null;
    const binary = resolveExecutable(provider.command, env);
    let mtime = 0;
    try {
      mtime = binary ? fs.statSync(binary).mtimeMs : 0;
    } catch {
      /* Raced with an uninstall. */
    }
    const key = `${id}\0${binary}\0${mtime}`;
    const cached = cache.get(id);
    if (!refresh && cached && cached.key === key && now() - cached.at < TTL_MS) return cached.value;
    if (inflight.has(key)) return inflight.get(key);
    const running = check(provider)
      .then((value) => {
        cache.set(id, { key, at: now(), value });
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, running);
    return running;
  }

  async function detectAll(options = {}) {
    const ids = Object.keys(registry);
    const results = await Promise.all(ids.map((id) => detect(id, options)));
    return results.filter(Boolean).sort((a, b) => Number(b.available) - Number(a.available) || (registry[a.id].rank ?? 99) - (registry[b.id].rank ?? 99));
  }

  return { detect, detectAll, resolve: (id) => resolveExecutable(registry[id]?.command, env) };
}
