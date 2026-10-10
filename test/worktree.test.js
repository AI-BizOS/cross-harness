import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { changes, commitAll, createWorktree, mergeBranch, removeWorktree, repoInfo, safeBranchPart, workingTree } from '../src/git/worktree.js';
import { CODES } from '../src/protocol/errors.js';
import { gitEnv, gitRepo, tempDir } from './helpers.js';

test('repoInfo tells git and plain directories apart', async (t) => {
  const { dir } = gitRepo(t);
  const info = await repoInfo(dir, gitEnv());
  assert.equal(info.isGit, true);
  assert.equal(info.branch, 'main');
  assert.match(info.head, /^[0-9a-f]{40}$/);
  const plain = tempDir(t);
  assert.equal((await repoInfo(plain, gitEnv())).isGit, false);
});

test('an agent works in its own worktree and its changes are reported', async (t) => {
  const env = gitEnv();
  const { dir } = gitRepo(t, { 'README.md': '# demo\n', 'src/a.js': 'export const a = 1;\n' });
  const home = tempDir(t);
  const wt = await createWorktree({ root: dir, dir: path.join(home, 'codex'), branch: 'cross-harness/codex', base: 'main', env });
  assert.equal(wt.created, true);
  fs.writeFileSync(path.join(wt.path, 'src/a.js'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(wt.path, 'new.txt'), 'hello\n');
  const diff = await changes({ dir: wt.path, base: 'main', env });
  assert.deepEqual(
    diff.files.map((f) => [f.path, f.status]).sort(),
    [
      ['new.txt', 'added'],
      ['src/a.js', 'modified'],
    ],
  );
  assert.equal(diff.uncommitted, true);
  assert.equal(diff.commits, 0);
  assert.match(diff.patch, /\+export const a = 2;/);
  // The agent's own index is untouched by the diff.
  assert.match(fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8'), /a = 1/);
  const tree = await workingTree(wt.path, env);
  assert.equal(tree, diff.tree);
  // Reusing the same directory for the same branch is fine.
  const again = await createWorktree({ root: dir, dir: wt.path, branch: 'cross-harness/codex', base: 'main', env });
  assert.equal(again.created, false);
  // Once everything is committed nothing is pending; staged work alone still is, and the
  // agent's index (copied for the snapshot) keeps what it staged.
  const git = (...args) => execFileSync('git', args, { cwd: wt.path, env, stdio: 'pipe' }).toString();
  git('add', '-A');
  git('commit', '-q', '-m', 'agent work');
  const committed = await changes({ dir: wt.path, base: 'main', env });
  assert.deepEqual([committed.uncommitted, committed.commits, committed.files.length], [false, 1, 2]);
  fs.writeFileSync(path.join(wt.path, 'staged.txt'), 'staged\n');
  git('add', 'staged.txt');
  const staged = await changes({ dir: wt.path, base: 'main', env });
  assert.equal(staged.uncommitted, true);
  assert.ok(staged.files.some((f) => f.path === 'staged.txt' && f.status === 'added'));
  assert.match(git('diff', '--cached', '--name-only'), /staged\.txt/);
});

test('a file changed right after checkout, keeping its size, is never missed', async (t) => {
  // The snapshot starts from a copy of the agent's index; git must not take that copy's
  // newer time as proof that a just-written file is unchanged ("racy git").
  const env = gitEnv();
  const { dir } = gitRepo(t, { 'a.js': 'export const a = 1;\n' });
  const home = tempDir(t);
  for (let i = 0; i < 20; i++) {
    const wt = await createWorktree({ root: dir, dir: path.join(home, `wt${i}`), branch: `cross-harness/racy-${i}`, base: 'main', env });
    fs.writeFileSync(path.join(wt.path, 'a.js'), 'export const a = 2;\n');
    const diff = await changes({ dir: wt.path, base: 'main', env });
    assert.deepEqual(diff.files.map((f) => f.path), ['a.js'], `attempt ${i + 1}`);
  }
});

test('merge commits pending work, merges with --no-ff and keeps the branch', async (t) => {
  const env = gitEnv();
  const { dir, git } = gitRepo(t);
  const home = tempDir(t);
  const wt = await createWorktree({ root: dir, dir: path.join(home, 'kimi'), branch: 'cross-harness/kimi', base: 'main', env });
  fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'done\n');
  const commit = await commitAll({ dir: wt.path, message: 'cross-harness: kimi work', env });
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(await commitAll({ dir: wt.path, message: 'nothing', env }), null);
  const result = await mergeBranch({ root: dir, branch: 'cross-harness/kimi', message: 'Merge cross-harness/kimi', env });
  assert.equal(result.target, 'main');
  assert.equal(result.commits, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'feature.txt'), 'utf8'), 'done\n');
  assert.match(git('log', '--oneline', '-1'), /Merge cross-harness\/kimi/);
  await assert.rejects(mergeBranch({ root: dir, branch: 'cross-harness/kimi', message: 'again', env }), (error) => error.code === CODES.MERGE_NOTHING);
  await removeWorktree({ root: dir, dir: wt.path, env });
  assert.equal(fs.existsSync(wt.path), false);
  assert.match(git('branch', '--list', 'cross-harness/kimi'), /cross-harness\/kimi/);
});

test('merge refuses a dirty project and aborts cleanly on conflict', async (t) => {
  const env = gitEnv();
  const { dir, git } = gitRepo(t, { 'shared.txt': 'base\n' });
  const home = tempDir(t);
  const wt = await createWorktree({ root: dir, dir: path.join(home, 'a'), branch: 'cross-harness/a', base: 'main', env });
  fs.writeFileSync(path.join(wt.path, 'shared.txt'), 'agent version\n');
  await commitAll({ dir: wt.path, message: 'agent edit', env });
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'user edit\n');
  await assert.rejects(mergeBranch({ root: dir, branch: 'cross-harness/a', message: 'm', env }), (error) => error.code === CODES.MERGE_DIRTY && error.files.includes('shared.txt'));
  git('commit', '-qam', 'user edit');
  await assert.rejects(mergeBranch({ root: dir, branch: 'cross-harness/a', message: 'm', env }), (error) => error.code === CODES.MERGE_CONFLICT && error.files.includes('shared.txt'));
  assert.equal(git('status', '--porcelain').trim(), '', 'merge aborted');
  assert.equal(fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8'), 'user edit\n');
});

test('branch names are sanitised', () => {
  assert.equal(safeBranchPart('Back End!'), 'back-end');
  assert.equal(safeBranchPart('..weird..name..'), 'weird.name');
  assert.equal(safeBranchPart('中文'), 'agent');
});
