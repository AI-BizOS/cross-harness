import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixture = (name) => path.join(ROOT, 'test', 'fixtures', name);
export const NODE = process.execPath;

export function tempDir(t, prefix = 'troupe-test-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t?.after?.(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A git repository with one commit on `main`. */
export function gitRepo(t, files = { 'README.md': '# demo\n' }) {
  const dir = tempDir(t, 'troupe-repo-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: gitEnv() }).toString();
  git('init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { dir, git };
}

export function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

export function events() {
  const list = [];
  const onEvent = (event) => list.push(event);
  return { list, onEvent, of: (type) => list.filter((event) => event.type === type) };
}

export async function until(check, { timeoutMs = 10_000, intervalMs = 20, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Provider definitions pointing at the mock agents. */
export function mockProviders() {
  return {
    'mock-acp': { id: 'mock-acp', name: 'Mock ACP', command: NODE, args: [fixture('mock-acp-agent.js')], protocol: 'acp', writes: true, verified: true },
    'mock-codex': { id: 'mock-codex', name: 'Mock Codex', command: NODE, args: [fixture('mock-codex.js')], protocol: 'codex-app', writes: true, verified: true },
    'mock-claude': { id: 'mock-claude', name: 'Mock Claude', command: NODE, args: [fixture('mock-claude.js')], protocol: 'claude-stream', writes: true, verified: true },
  };
}
