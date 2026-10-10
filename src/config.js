// User configuration and state locations. Only user-level configuration can name
// commands to run: a project directory (which may be someone else's repository)
// never decides what Troupe executes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PERMISSION_MODES } from './protocol/index.js';
import { readJson } from './util/fsx.js';

export const DEFAULTS = Object.freeze({
  mode: 'workspace',
  isolation: 'worktree',
  maxPerProvider: 3,
  idleMinutes: 15,
  gateTimeoutSec: 600,
  maxIterations: 5,
});

export function troupeHome(env = process.env) {
  return env.TROUPE_HOME ? path.resolve(env.TROUPE_HOME) : path.join(env.HOME || env.USERPROFILE || os.homedir(), '.troupe');
}

export function loadConfig(env = process.env) {
  const file = path.join(troupeHome(env), 'config.json');
  const raw = readJson(file, {}) || {};
  const defaults = { ...DEFAULTS };
  const given = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};
  if (PERMISSION_MODES.includes(given.mode)) defaults.mode = given.mode;
  if (['worktree', 'shared'].includes(given.isolation)) defaults.isolation = given.isolation;
  for (const key of ['maxPerProvider', 'idleMinutes', 'gateTimeoutSec', 'maxIterations']) {
    if (Number.isFinite(given[key]) && given[key] > 0) defaults[key] = given[key];
  }
  return {
    file,
    providers: raw.providers && typeof raw.providers === 'object' ? raw.providers : {},
    defaults,
    lang: typeof raw.lang === 'string' ? raw.lang : null,
    // false turns off the one-time question about starring Troupe on GitHub.
    starPrompt: raw.starPrompt !== false,
  };
}

/** Stable id for a project: readable name plus a hash of its real path. */
export function projectId(root) {
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    /* Use the given path. */
  }
  const name = path.basename(real).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'project';
  return `${name}-${createHash('sha256').update(real).digest('hex').slice(0, 12)}`;
}

export function projectStateDir(root, env = process.env) {
  return path.join(troupeHome(env), 'projects', projectId(root));
}
