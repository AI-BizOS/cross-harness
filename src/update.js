// Newer releases: `troupe update` installs the newest one, and the interactive interfaces
// mention it once a newer one exists. The check reads the public repository's release tags
// with `git ls-remote`, so git's proxy settings apply, at most once a day and in the
// background; nothing about you or your projects is sent. Turn the check off with
// `"updateCheck": false`, TROUPE_NO_UPDATE_CHECK or CI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './util/fsx.js';
import { runCommand } from './util/process.js';

export const REPOSITORY = 'https://github.com/AI-BizOS/troupe';
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 24 * 60 * 60 * 1000;
const RELEASE_TAG = /^[0-9a-f]+\trefs\/tags\/v(\d+\.\d+\.\d+)$/gm;

/** Compares two x.y.z versions: negative, zero or positive. */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** The release package of a version, as the README installs it. */
export function releaseUrl(version) {
  return `${REPOSITORY}/releases/download/v${version}/bizos-ai-troupe-${version}.tgz`;
}

/** The newest released version (from tags like v0.1.2), or null when there is none. */
export async function latestRelease({ env = process.env, repository = env.TROUPE_UPDATE_REPOSITORY || `${REPOSITORY}.git`, run = runCommand, timeoutMs = 15_000 } = {}) {
  const result = await run('git', ['ls-remote', '--tags', '--refs', repository], { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs });
  if (result.error || result.timedOut || result.code !== 0) {
    throw new Error(result.timedOut ? `git ls-remote did not answer within ${timeoutMs / 1000} seconds` : String(result.stderr || result.error?.message || `git exited with ${result.code}`).trim().split('\n').pop());
  }
  const versions = [...String(result.stdout).matchAll(RELEASE_TAG)].map((m) => m[1]);
  return versions.sort(compareVersions).at(-1) || null;
}

/** A git checkout is updated with git; an installed package is replaced with npm. */
export function installKind(root = PACKAGE_ROOT) {
  return fs.existsSync(path.join(root, '.git')) ? 'source' : 'package';
}

/**
 * The once-a-day check behind the interfaces' notice, or null when it is turned off.
 * `check()` resolves to {current, latest} when a newer release exists, else null; it
 * never throws, and a failed check is not retried before the next day.
 */
export function updateCheckFor({ home, config, current, env = process.env, now = Date.now, latest = latestRelease }) {
  if (config?.updateCheck === false || env.TROUPE_NO_UPDATE_CHECK || env.CI) return null;
  const file = path.join(home, 'update.json');
  let pending = null;
  async function check() {
    const state = readJson(file, null) || {};
    let found = typeof state.latest === 'string' ? state.latest : null;
    if (!state.checkedAt || !(now() - Date.parse(state.checkedAt) < DAY_MS)) {
      found = await latest({ env }).catch(() => found);
      try {
        writeJsonAtomic(file, { schema: 1, checkedAt: new Date(now()).toISOString(), latest: found });
      } catch {
        /* The next start checks again. */
      }
    }
    return found && compareVersions(found, current) > 0 ? { current, latest: found } : null;
  }
  return {
    check() {
      pending ??= check().catch(() => null);
      return pending;
    },
  };
}
