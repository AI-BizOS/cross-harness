import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareVersions, installKind, latestRelease, releaseUrl, updateCheckFor } from '../src/update.js';
import { NODE, ROOT, gitEnv, tempDir } from './helpers.js';

/** A repository whose tags stand in for the GitHub releases. */
function releases(t, tags) {
  const dir = tempDir(t, 'cross-harness-releases-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: gitEnv(), stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'release');
  for (const tag of tags) git('tag', tag);
  return dir;
}

test('versions compare by number and releases come from version tags', async (t) => {
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0);
  assert.ok(compareVersions('0.2.0', '0.10.0') < 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(releaseUrl('0.1.3'), 'https://github.com/AI-BizOS/cross-harness/releases/download/v0.1.3/bizos-ai-cross-harness-0.1.3.tgz');
  assert.equal(await latestRelease({ repository: releases(t, ['v0.1.1', 'v0.1.10', 'v0.1.9', 'notes', 'v2-beta']) }), '0.1.10');
  assert.equal(await latestRelease({ repository: releases(t, []) }), null);
  await assert.rejects(latestRelease({ repository: path.join(tempDir(t), 'missing') }));
  assert.equal(installKind(ROOT), fs.existsSync(path.join(ROOT, '.git')) ? 'source' : 'package');
  assert.equal(installKind(tempDir(t)), 'package');
});

test('the interfaces check at most once a day and only when allowed', async (t) => {
  const home = tempDir(t);
  assert.equal(updateCheckFor({ home, config: { updateCheck: false }, current: '0.1.0', env: {} }), null);
  assert.equal(updateCheckFor({ home, config: {}, current: '0.1.0', env: { CROSS_HARNESS_NO_UPDATE_CHECK: '1' } }), null);
  assert.equal(updateCheckFor({ home, config: {}, current: '0.1.0', env: { CI: 'true' } }), null);
  let clock = Date.parse('2026-10-10T12:00:00Z');
  let asked = 0;
  let answer = '0.2.0';
  const make = (current) => updateCheckFor({ home, config: {}, current, env: {}, now: () => clock, latest: async () => (asked++, typeof answer === 'string' ? answer : Promise.reject(answer)) });
  assert.deepEqual(await make('0.1.0').check(), { current: '0.1.0', latest: '0.2.0' });
  assert.equal(await make('0.2.0').check(), null, 'not newer');
  assert.equal(asked, 1, 'the answer is kept for a day');
  clock += 25 * 60 * 60 * 1000;
  answer = new Error('offline');
  assert.deepEqual(await make('0.1.0').check(), { current: '0.1.0', latest: '0.2.0' }, 'a failed check keeps the last answer');
  assert.equal(asked, 2);
  assert.equal(await make('0.1.0').check().then(() => asked), 2, 'and is not retried the same day');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'update.json'), 'utf8')).latest, '0.2.0');
});

test('cross-harness update reports a newer release and how to get it', (t) => {
  const home = tempDir(t);
  const run = (tags, ...args) => execFileSync(NODE, [path.join(ROOT, 'bin', 'cross-harness.js'), 'update', ...args], { env: { ...process.env, CROSS_HARNESS_HOME: home, CROSS_HARNESS_UPDATE_REPOSITORY: releases(t, tags), CROSS_HARNESS_LANG: 'en' }, encoding: 'utf8' });
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(run(['v9.0.0', 'v1.0.0'], '--check'), `cross-harness 9.0.0 is available (you have ${version}).\n`);
  assert.equal(run([`v${version}`], '--check'), `cross-harness ${version} is the newest release.\n`);
  assert.equal(run(['v0.0.1'], '--check'), `cross-harness ${version} is newer than the newest release (0.0.1).\n`);
  // This checkout is updated with git, not replaced by a package.
  if (installKind(ROOT) === 'source') assert.match(run(['v9.0.0']), /runs from a git checkout at .*; update it with `git -C .* pull`/);
});
