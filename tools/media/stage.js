// The stage for a recording: a fresh copy of the demo project as a git repository,
// and a Troupe engine whose @claude, @codex and @kimi are the stand-in agents. The
// stand-ins keep the real harnesses' names and "verified" labels, so the interface
// shows what it would show for the real ones.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../src/engine/engine.js';
import { BUILTIN_PROVIDERS } from '../../src/providers/registry.js';
import { PROJECT } from './story.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STANDINS = { claude: 'claude.js', codex: 'codex.js', kimi: 'acp.js' };

// Agents show absolute paths, so the demo lives at a short, neutral place. The real
// path: an agent's directory inside its worktree is computed from it.
export const DEFAULT_ROOT = path.join(fs.realpathSync(os.tmpdir()), 'troupe-demo');

function demoEnv(extra) {
  return {
    ...process.env,
    ...extra,
    GIT_AUTHOR_NAME: 'Troupe demo',
    GIT_AUTHOR_EMAIL: 'demo@troupe.invalid',
    GIT_COMMITTER_NAME: 'Troupe demo',
    GIT_COMMITTER_EMAIL: 'demo@troupe.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

export function standinProviders(lang) {
  return Object.fromEntries(
    Object.entries(STANDINS).map(([id, file]) => {
      const { name, vendor, protocol, rank, verified } = BUILTIN_PROVIDERS[id];
      const script = path.join(HERE, 'standins', file);
      return [id, { name, vendor, protocol, rank, verified, writes: true, command: process.execPath, args: [script], versionArgs: [script, '--version'], env: { DEMO_ROLE: id, DEMO_LANG: lang } }];
    }),
  );
}

/** A new demo project and an open engine on it. */
export async function stage({ root = DEFAULT_ROOT, lang = 'en' } = {}) {
  fs.rmSync(root, { recursive: true, force: true });
  const project = path.join(root, PROJECT.name);
  for (const [file, text] of Object.entries(PROJECT.files)) {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), text);
  }
  const env = demoEnv({ TROUPE_HOME: path.join(root, '.troupe'), DEMO_LANG: lang });
  const git = (...args) => execFileSync('git', args, { cwd: project, env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'Import orders from CSV');
  const engine = new Engine({ root: project, env, builtins: false, providers: standinProviders(lang) });
  await engine.open();
  return { engine, project, root, env };
}
