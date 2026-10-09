import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  const wt = await createWorktree({ root: dir, dir: path.join(home, 'codex'), branch: 'troupe/codex', base: 'main', env });
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
  const again = await createWorktree({ root: dir, dir: wt.path, branch: 'troupe/codex', base: 'main', env });
  assert.equal(again.created, false);
});

test('merge commits pending work, merges with --no-ff and keeps the branch', async (t) => {
  const env = gitEnv();
  const { dir, git } = gitRepo(t);
  const home = tempDir(t);
  const wt = await createWorktree({ root: dir, dir: path.join(home, 'kimi'), branch: 'troupe/kimi', base: 'main', env });
  fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'done\n');
  const commit = await commitAll({ dir: wt.path, message: 'troupe: kimi work', env });
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(await commitAll({ dir: wt.path, message: 'nothing', env }), null);
  const result = await mergeBranch({ root: dir, branch: 'troupe/kimi', message: 'Merge troupe/kimi', env });
  assert.equal(result.target, 'main');
  assert.equal(result.commits, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'feature.txt'), 'utf8'), 'done\n');
  assert.match(git('log', '--oneline', '-1'), /Merge troupe\/kimi/);
  await assert.rejects(mergeBranch({ root: dir, branch: 'troupe/kimi', message: 'again', env }), (error) => error.code === CODES.MERGE_NOTHING);
  await removeWorktree({ root: dir, dir: wt.path, env });
  assert.equal(fs.existsSync(wt.path), false);
  assert.match(git('branch', '--list', 'troupe/kimi'), /troupe\/kimi/);
});

test('merge refuses a dirty project and aborts cleanly on conflict', async (t) => {
  const env = gitEnv();
  const { dir, git } = gitRepo(t, { 'shared.txt': 'base\n' });
  const home = tempDir(t);
  const wt = await createWorktree({ root: dir, dir: path.join(home, 'a'), branch: 'troupe/a', base: 'main', env });
  fs.writeFileSync(path.join(wt.path, 'shared.txt'), 'agent version\n');
  await commitAll({ dir: wt.path, message: 'agent edit', env });
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'user edit\n');
  await assert.rejects(mergeBranch({ root: dir, branch: 'troupe/a', message: 'm', env }), (error) => error.code === CODES.MERGE_DIRTY && error.files.includes('shared.txt'));
  git('commit', '-qam', 'user edit');
  await assert.rejects(mergeBranch({ root: dir, branch: 'troupe/a', message: 'm', env }), (error) => error.code === CODES.MERGE_CONFLICT && error.files.includes('shared.txt'));
  assert.equal(git('status', '--porcelain').trim(), '', 'merge aborted');
  assert.equal(fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8'), 'user edit\n');
});

test('branch names are sanitised', () => {
  assert.equal(safeBranchPart('Back End!'), 'back-end');
  assert.equal(safeBranchPart('..weird..name..'), 'weird.name');
  assert.equal(safeBranchPart('中文'), 'agent');
});
