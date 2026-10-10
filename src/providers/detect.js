// Finds installed harnesses and their versions. Results are cached and concurrent checks
// share one probe, so sending a message or opening a picker never re-runs every CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../util/process.js';
import { launchCommand } from './launch.js';

// The cache key includes the binary's path and modification time, so installing,
// upgrading or removing a harness is noticed at once; the TTL only bounds staleness.
const TTL_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;

/** Windows variables are case-insensitive, but a copied environment keeps their case. */
export function envValue(env, name) {
  const key = Object.keys(env || {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

const homeOf = (env) => envValue(env, 'HOME') || envValue(env, 'USERPROFILE') || os.homedir();
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isExecutable(file, platform) {
  if (!isFile(file)) return false;
  if (platform === 'win32') return true;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const newestFirst = (a, b) => {
  const [x, y] = [a, b].map((v) => v.slice(1).split('.').map(Number));
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
};

/**
 * Where installers, package managers and version managers put commands, searched after
 * PATH: a harness installed under nvm, volta, pnpm or Homebrew is found even when Troupe
 * starts from a shell whose PATH does not include that manager.
 */
export function installDirs(env = process.env, platform = process.platform) {
  const p = pathFor(platform);
  const home = homeOf(env);
  const dirs = [p.join(home, '.local', 'bin'), p.join(home, '.npm-global', 'bin')];
  for (const prefix of [envValue(env, 'npm_config_prefix'), envValue(env, 'PNPM_HOME')]) if (prefix && p.isAbsolute(prefix)) dirs.push(prefix, p.join(prefix, 'bin'));
  if (platform === 'win32') {
    const appData = envValue(env, 'APPDATA');
    const localAppData = envValue(env, 'LOCALAPPDATA');
    if (appData) dirs.push(p.join(appData, 'npm'));
    if (localAppData) dirs.push(p.join(localAppData, 'npm'), p.join(localAppData, 'pnpm'));
    for (const root of [envValue(env, 'ProgramFiles'), envValue(env, 'ProgramFiles(x86)')].filter(Boolean)) dirs.push(p.join(root, 'nodejs'));
    dirs.push(p.join(home, 'scoop', 'shims'), p.join(home, '.bun', 'bin'), p.join(home, '.cargo', 'bin'), p.join(home, '.volta', 'bin'));
    return dirs;
  }
  const nvm = envValue(env, 'NVM_DIR') || p.join(home, '.nvm');
  const versions = entries(p.join(nvm, 'versions', 'node'))
    .map((item) => item.name)
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
    .sort(newestFirst);
  dirs.push(
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...versions.map((version) => p.join(nvm, 'versions', 'node', version, 'bin')),
    p.join(envValue(env, 'VOLTA_HOME') || p.join(home, '.volta'), 'bin'),
    p.join(home, '.asdf', 'shims'),
    p.join(home, '.local', 'share', 'mise', 'shims'),
    p.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    p.join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
    p.join(home, '.bun', 'bin'),
    p.join(home, 'Library', 'pnpm'),
    p.join(home, '.local', 'share', 'pnpm'),
    p.join(home, '.yarn', 'bin'),
    p.join(home, '.cargo', 'bin'),
    p.join(home, 'go', 'bin'),
    p.join(home, '.opencode', 'bin'),
    p.join(home, '.claude', 'local'),
  );
  return dirs;
}

// Installers that put a command in their own directory and add it to PATH only for
// shells started afterwards.
const COMMAND_DIRS = {
  kimi: (env, p) => [p.join(envValue(env, 'KIMI_CODE_HOME') || p.join(homeOf(env), '.kimi-code'), 'bin')],
};

/**
 * DeepSeek Harness desktop can be installed without registering its `dsh` command; its
 * CLI is then run from the app (a Node script with the app's own Node on macOS, the app's
 * wrapper on Windows). A renamed backup is not an installed app.
 */
export function deepseekDesktop(env = process.env, platform = process.platform) {
  const p = pathFor(platform);
  const roots =
    platform === 'win32'
      ? [envValue(env, 'LOCALAPPDATA') && p.join(envValue(env, 'LOCALAPPDATA'), 'Programs'), envValue(env, 'ProgramFiles')].filter(Boolean)
      : platform === 'darwin'
        ? ['/Applications', p.join(homeOf(env), 'Applications')]
        : [];
  for (const root of roots) {
    for (const item of entries(root).slice(0, 256)) {
      if (!item.isDirectory() || !/deepseek|dsh/i.test(item.name) || /\.bak$|backup/i.test(item.name)) continue;
      if (platform === 'darwin' && !/\.app$/i.test(item.name)) continue;
      const app = p.join(root, item.name);
      const entry = platform === 'win32' ? p.join(app, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd') : p.join(app, 'Contents', 'Resources', 'runtime', 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (isFile(entry)) return entry;
    }
  }
  return null;
}

/** Absolute path of `command`: PATH, then the installer's own directory, then common install directories. */
export function resolveExecutable(command, env = process.env, platform = process.platform) {
  if (!command) return null;
  const p = pathFor(platform);
  if (p.isAbsolute(command)) return isExecutable(command, platform) || (/\.[cm]?js$/i.test(command) && isFile(command)) ? command : null;
  if (command.includes('/') || command.includes('\\')) return null;
  // Only what can be started: an .exe directly, a .cmd/.bat wrapper through launch.js.
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : [''];
  const dirs = [...String(envValue(env, 'PATH') || '').split(platform === 'win32' ? ';' : ':').filter(Boolean), ...(COMMAND_DIRS[command]?.(env, p) || []), ...installDirs(env, platform)];
  for (const dir of new Set(dirs)) {
    for (const ext of exts) {
      const candidate = p.join(dir, command + ext);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return command === 'dsh' ? deepseekDesktop(env, platform) : null;
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
    let launch;
    try {
      launch = launchCommand(binary, provider.versionArgs || ['--version'], env);
    } catch (error) {
      return { ...base, available: false, binary, version: null, reason: 'launch-failed', fix: error.message };
    }
    const result = await probe(launch.binary, launch.args, { env: launch.env, timeoutMs: PROBE_TIMEOUT_MS });
    const version = parseVersion(`${result.stdout}\n${result.stderr}`);
    // A harness that is slow to start (a first run, a busy virus scanner) is still installed.
    if (result.timedOut) return { ...base, available: true, binary, version: null, reason: null, fix: null, note: `\`${provider.command} --version\` did not answer within 10 seconds`, signIn: provider.signIn || null };
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
