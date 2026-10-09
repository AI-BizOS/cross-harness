import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { connectRemote, sshCommand } from '../src/engine/rpc.js';
import { parseArgs } from '../src/cli/args.js';
import { CODES } from '../src/protocol/errors.js';
import { NODE, ROOT, fixture, gitEnv, gitRepo, tempDir, until } from './helpers.js';

const BIN = path.join(ROOT, 'bin', 'troupe.js');

/** TROUPE_HOME with a config that registers the mock agents, as a user would register BizOS. */
function home(t) {
  const dir = tempDir(t, 'troupe-home-');
  fs.mkdirSync(path.join(dir, 'mock'));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      providers: {
        'mock-acp': { name: 'Mock ACP', command: NODE, args: [fixture('mock-acp-agent.js')], protocol: 'acp', verified: true },
        'mock-codex': { name: 'Mock Codex', command: NODE, args: [fixture('mock-codex.js')], protocol: 'codex-app', verified: true },
      },
    }),
  );
  return { dir, env: { ...gitEnv(), TROUPE_HOME: dir, MOCK_STATE: path.join(dir, 'mock') } };
}

test('a remote engine is driven over stdio, as over ssh', async (t) => {
  const { env } = home(t);
  const repo = gitRepo(t);
  const client = await connectRemote({ command: NODE, args: [BIN, 'serve', '--stdio', '--cwd', repo.dir], env, label: 'test remote' });
  t.after(() => client.close());
  assert.equal(client.initial.project.root, repo.dir);
  const events = [];
  client.subscribe((event) => events.push(event));
  const sent = await client.call('send', { text: '@mock-acp hello from afar' });
  assert.equal(sent.dispatched[0].agent, 'mock-acp');
  await until(() => events.some((e) => e.type === 'agent.message' && e.entry.role === 'assistant'), { label: 'remote answer', timeoutMs: 20_000 });
  const answer = events.find((e) => e.type === 'agent.message' && e.entry.role === 'assistant');
  assert.match(answer.entry.text, /mock-acp answered: hello from afar/);
  // Errors keep their codes across the wire.
  await assert.rejects(client.call('stop', { agent: 'nobody' }), (error) => error.code === CODES.AGENT_NOT_FOUND);
  await assert.rejects(client.call('evil', {}), (error) => error.code === CODES.METHOD_UNKNOWN);
  const snapshot = await client.call('snapshot');
  assert.equal(snapshot.agents.length, 1);
});

test('troupe run sends, waits and prints the answers', (t) => {
  const { env } = home(t);
  const repo = gitRepo(t);
  const out = execFileSync(NODE, [BIN, 'run', '@mock-acp @mock-codex count to three', '--cwd', repo.dir, '--json'], { env, encoding: 'utf8', timeout: 60_000 });
  const result = JSON.parse(out);
  assert.deepEqual(result.dispatched.map((d) => d.agent).sort(), ['mock-acp', 'mock-codex']);
  assert.equal(result.answers.length, 2);
  assert.ok(result.answers.every((a) => /answered: count to three/.test(a.text)));
});

test('troupe run denies approvals unless allowed', (t) => {
  const { env } = home(t);
  const repo = gitRepo(t);
  const denied = spawnSync(NODE, [BIN, 'run', '@mock-acp do it [approve]', '--cwd', repo.dir, '--mode', 'ask'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(denied.status, 0, denied.stderr);
  assert.match(denied.stderr, /asked: npm test — denied/);
  assert.match(denied.stdout, /npm test denied/);
  const allowed = spawnSync(NODE, [BIN, 'run', '@mock-acp do it [approve]', '--cwd', repo.dir, '--yes'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.doesNotMatch(allowed.stdout, /denied/);
});

test('troupe detect, agents, help and version', (t) => {
  const { env } = home(t);
  const repo = gitRepo(t);
  const detected = JSON.parse(execFileSync(NODE, [BIN, 'detect', '--json'], { env, encoding: 'utf8', timeout: 60_000 }));
  assert.ok(detected.some((p) => p.id === 'mock-acp' && p.available));
  assert.ok(detected.some((p) => p.id === 'claude'));
  const list = execFileSync(NODE, [BIN, 'agents', '--cwd', repo.dir], { env, encoding: 'utf8', timeout: 30_000 });
  assert.match(list, /No agents yet/);
  assert.match(execFileSync(NODE, [BIN, '--help'], { env, encoding: 'utf8' }), /troupe run/);
  assert.match(execFileSync(NODE, [BIN, '--version'], { env, encoding: 'utf8' }), /troupe 0\.1\.0 \(troupe\/1\)/);
  const bad = spawnSync(NODE, [BIN, '--bogus'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const tui = spawnSync(NODE, [BIN, '--cwd', repo.dir], { env, encoding: 'utf8', input: '' });
  assert.equal(tui.status, 2);
  assert.match(tui.stderr, /interactive terminal/);
});

test('argument parsing and ssh command lines', () => {
  const spec = { boolean: ['json'], string: ['cwd'], alias: { C: 'cwd' } };
  assert.deepEqual(parseArgs(['run', '-C', '/x', '--json', 'msg'], spec), { flags: { cwd: '/x', json: true }, positionals: ['run', 'msg'] });
  assert.deepEqual(parseArgs(['--cwd=/y', '--', '--not-a-flag'], spec), { flags: { cwd: '/y' }, positionals: ['--not-a-flag'] });
  assert.throws(() => parseArgs(['--nope'], spec), /Unknown option/);
  assert.deepEqual(sshCommand('dev@box', { cwd: "/srv/it's here" }), {
    command: 'ssh',
    args: ['-T', '-o', 'BatchMode=yes', 'dev@box', "troupe serve --stdio --cwd '/srv/it'\\''s here'"],
  });
  assert.throws(() => sshCommand('-oProxyCommand=touch /tmp/x'), (error) => error.code === CODES.ARGUMENT_INVALID);
});
