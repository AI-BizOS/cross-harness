// Git isolation for agents that write: each gets its own worktree on its own branch,
// and its work comes back through a reviewed, conflict-safe merge (spec/orchestration.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODES, fail } from '../protocol/errors.js';
import { runCommand } from '../util/process.js';

const MAX_PATCH = 2 * 1024 * 1024;
const FALLBACK_IDENTITY = ['-c', 'user.name=BizOS', '-c', 'user.email=bizos-ai@users.noreply.github.com'];

/** Runs git and returns stdout; throws a cross-harnessError with stderr on failure. */
export async function git(args, { cwd, env = process.env, timeoutMs = 60_000, allowFail = false } = {}) {
  const result = await runCommand('git', args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw fail(CODES.WORKTREE_FAILED, `git is not available: ${result.error.message}`);
  if (result.code !== 0 && !allowFail) {
    throw fail(CODES.WORKTREE_FAILED, `git ${args[0]} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`, { exitCode: result.code, stderr: result.stderr });
  }
  return allowFail ? result : result.stdout;
}

export async function repoInfo(dir, env) {
  const top = await git(['rev-parse', '--show-toplevel'], { cwd: dir, env, allowFail: true });
  if (top.code !== 0) return { isGit: false, root: path.resolve(dir), branch: null, head: null };
  const root = top.stdout.trim();
  const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, env, allowFail: true })).stdout.trim() || null;
  const head = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, env, allowFail: true })).stdout.trim() || null;
  return { isGit: true, root, branch, head };
}

async function hasIdentity(cwd, env) {
  const email = await git(['config', 'user.email'], { cwd, env, allowFail: true });
  return email.code === 0 && email.stdout.trim().length > 0;
}

async function branchExists(root, branch, env) {
  return (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root, env, allowFail: true })).code === 0;
}

export function safeBranchPart(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .replace(/\.\.+/g, '.')
      .slice(0, 40) || 'agent'
  );
}

/**
 * Creates (or reuses) a worktree for an agent.
 * @returns {Promise<{path:string, branch:string, base:string, created:boolean}>}
 */
export async function createWorktree({ root, dir, branch, base, env }) {
  if (!base) throw fail(CODES.WORKTREE_FAILED, 'The repository has no commit to branch from yet; make a first commit');
  if (fs.existsSync(path.join(dir, '.git'))) {
    const current = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: dir, env, allowFail: true })).stdout.trim();
    if (current === branch) return { path: dir, branch, base, created: false };
    throw fail(CODES.WORKTREE_FAILED, `${dir} already holds another checkout (${current || 'detached'})`);
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  // A branch left by an earlier agent of the same name is reused, not reset.
  const args = (await branchExists(root, branch, env)) ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, base];
  await git(args, { cwd: root, env });
  return { path: dir, branch, base, created: true };
}

/** Removes the worktree directory; the branch (and its commits) are kept. */
export async function removeWorktree({ root, dir, force = false, env }) {
  if (!fs.existsSync(dir)) {
    await git(['worktree', 'prune'], { cwd: root, env, allowFail: true });
    return { removed: false };
  }
  const result = await git(['worktree', 'remove', ...(force ? ['--force'] : []), dir], { cwd: root, env, allowFail: true });
  if (result.code !== 0) throw fail(CODES.WORKTREE_FAILED, `Could not remove the worktree: ${result.stderr.trim()}`, { stderr: result.stderr });
  return { removed: true };
}

/**
 * Snapshot of everything in a worktree (tracked and untracked, respecting
 * .gitignore) through a private index, so the agent's own index is untouched.
 */
async function withScratchIndex(dir, env, work) {
  const index = path.join(os.tmpdir(), `cross-harness-index-${randomUUID()}`);
  const scratch = { ...env, GIT_INDEX_FILE: index };
  try {
    // A copy of the worktree's own index keeps the size and time of every file, so git
    // reads only what changed; an index built from HEAD would make it read the whole tree.
    const own = path.resolve(dir, (await git(['rev-parse', '--git-path', 'index'], { cwd: dir, env })).trim());
    if (fs.existsSync(own)) {
      fs.copyFileSync(own, index);
      // Git trusts a file's recorded size and time only when the file is older than the
      // index ("racy git"). The copy must not look newer than the original, or a file
      // changed just after the original was written would pass as unchanged.
      const { atime, mtime } = fs.statSync(own);
      fs.utimesSync(index, atime, new Date(mtime.getTime() - 1000));
    } else {
      await git(['read-tree', 'HEAD'], { cwd: dir, env: scratch });
    }
    await git(['add', '-A'], { cwd: dir, env: scratch, timeoutMs: 120_000 });
    return await work(scratch);
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** Tree id of the worktree's current contents, committed or not. */
export async function workingTree(dir, env) {
  return withScratchIndex(dir, env, async (scratch) => (await git(['write-tree'], { cwd: dir, env: scratch })).trim());
}

/**
 * What an agent changed relative to where its branch left `base`.
 * @returns {Promise<{base:string, mergeBase:string, files:{path:string,status:string,added:number|null,removed:number|null}[], commits:number, uncommitted:boolean, patch:string, truncated:boolean, tree:string}>}
 */
export async function changes({ dir, base, env }) {
  const [mergeBase, headTree] = await Promise.all([git(['merge-base', base, 'HEAD'], { cwd: dir, env }), git(['rev-parse', 'HEAD^{tree}'], { cwd: dir, env })].map((run) => run.then((out) => out.trim())));
  return withScratchIndex(dir, env, async (scratch) => {
    // The snapshot is complete once `add -A` has run; everything else only reads it.
    const diff = (...args) => git(['diff', '--cached', '--no-color', '--no-renames', ...args, mergeBase], { cwd: dir, env: scratch });
    const [names, counts, fullPatch, tree, count] = await Promise.all([
      diff('--name-status').then((out) => out.trim()),
      diff('--numstat').then((out) => out.trim()),
      diff(),
      git(['write-tree'], { cwd: dir, env: scratch }).then((out) => out.trim()),
      git(['rev-list', '--count', `${mergeBase}..HEAD`], { cwd: dir, env }),
    ]);
    const stat = new Map(
      counts
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [added, removed, ...rest] = line.split('\t');
          return [rest.join('\t'), { added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed) }];
        }),
    );
    const files = names
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [code, ...rest] = line.split('\t');
        const file = rest.join('\t');
        return { path: file, status: { A: 'added', D: 'deleted', M: 'modified', T: 'modified' }[code[0]] || 'modified', ...(stat.get(file) || { added: null, removed: null }) };
      });
    const truncated = fullPatch.length > MAX_PATCH;
    const patch = truncated ? fullPatch.slice(0, MAX_PATCH) : fullPatch;
    // Anything staged, changed or untracked (and not ignored) makes the snapshot differ from HEAD.
    return { base, mergeBase, files, commits: Number(count.trim()) || 0, uncommitted: tree !== headTree, patch, truncated, tree };
  });
}

/** Commits everything in the worktree. Returns the new commit, or null if clean. */
export async function commitAll({ dir, message, env }) {
  await git(['add', '-A'], { cwd: dir, env, timeoutMs: 120_000 });
  const staged = await git(['diff', '--cached', '--quiet'], { cwd: dir, env, allowFail: true });
  if (staged.code === 0) return null;
  const identity = (await hasIdentity(dir, env)) ? [] : FALLBACK_IDENTITY;
  await git([...identity, 'commit', '--no-verify', '-q', '-m', message], { cwd: dir, env });
  return (await git(['rev-parse', 'HEAD'], { cwd: dir, env })).trim();
}

/**
 * Merges `branch` into the branch checked out at `root` with --no-ff. Refuses when
 * the target has uncommitted changes; aborts and lists files on conflict.
 */
export async function mergeBranch({ root, branch, message, env }) {
  // Porcelain lines are "XY path": the leading status column may be a space.
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'], { cwd: root, env })).split('\n').filter((line) => line.trim());
  if (dirty.length) {
    throw fail(CODES.MERGE_DIRTY, 'The project has uncommitted changes; commit or stash them before merging', {
      files: dirty.map((line) => line.slice(3)).slice(0, 50),
    });
  }
  const target = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, env, allowFail: true })).stdout.trim() || 'HEAD';
  const ahead = Number((await git(['rev-list', '--count', `HEAD..${branch}`], { cwd: root, env })).trim()) || 0;
  if (!ahead) throw fail(CODES.MERGE_NOTHING, `${branch} has nothing that ${target} does not already have`);
  const identity = (await hasIdentity(root, env)) ? [] : FALLBACK_IDENTITY;
  const result = await git([...identity, 'merge', '--no-ff', '--no-edit', '-m', message, branch], { cwd: root, env, allowFail: true, timeoutMs: 120_000 });
  if (result.code !== 0) {
    const conflicted = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd: root, env, allowFail: true })).stdout.trim();
    await git(['merge', '--abort'], { cwd: root, env, allowFail: true });
    if (conflicted) {
      throw fail(CODES.MERGE_CONFLICT, `Merging ${branch} into ${target} conflicts; nothing was changed`, { files: conflicted.split('\n') });
    }
    throw fail(CODES.MERGE_FAILED, `Merging ${branch} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ')}`, { stderr: result.stderr });
  }
  const commit = (await git(['rev-parse', 'HEAD'], { cwd: root, env })).trim();
  return { target, branch, commit, commits: ahead };
}
