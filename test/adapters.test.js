import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAcpSession } from '../src/adapters/acp.js';
import { createCodexSession, mcpConfigArgs } from '../src/adapters/codex.js';
import { createClaudeSession, mcpConfig } from '../src/adapters/claude.js';
import { createExecSession } from '../src/adapters/exec.js';
import { CODES } from '../src/protocol/errors.js';
import { NODE, events, fixture, tempDir, until } from './helpers.js';

function setup(t, extraEnv = {}) {
  const dir = tempDir(t);
  const state = path.join(dir, '.mock');
  fs.mkdirSync(state);
  const log = path.join(dir, 'mock.log');
  const env = { ...process.env, MOCK_STATE: state, MOCK_LOG: log, ...extraEnv };
  const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { dir, env, read };
}

const ADAPTERS = [
  ['acp', (o) => createAcpSession({ binary: NODE, args: [fixture('mock-acp-agent.js')], label: 'Mock ACP', ...o })],
  ['codex', (o) => createCodexSession({ binary: NODE, args: [fixture('mock-codex.js')], label: 'Mock Codex', ...o })],
  ['claude', (o) => createClaudeSession({ binary: NODE, args: [fixture('mock-claude.js')], label: 'Mock Claude', ...o })],
];

for (const [name, create] of ADAPTERS) {
  test(`${name}: a turn streams text and activity and returns the answer`, async (t) => {
    const { dir, env } = setup(t);
    const session = create({ cwd: dir, env });
    t.after(() => session.close());
    const ev = events();
    const started = await session.start({ permissionMode: 'workspace', onEvent: ev.onEvent });
    assert.equal(typeof started.sessionId === 'string' || started.sessionId === null, true);
    const result = await session.prompt('hello there');
    assert.match(result.text, /answered: hello there/);
    assert.ok(ev.of('text').length >= 1, 'text events');
    assert.match(ev.of('text').at(-1).text, /answered: hello there/);
    assert.ok(ev.of('activity').length >= 1, 'activity events');
    assert.ok(session.alive);
    // The same live process answers the next turn.
    const pid = session.pid;
    const again = await session.prompt('second [echo]');
    assert.ok(again.text.includes('second'));
    assert.equal(session.pid, pid);
  });

  test(`${name}: approvals reach the client and the decision reaches the agent`, async (t) => {
    const { dir, env } = setup(t);
    const session = create({ cwd: dir, env });
    t.after(() => session.close());
    const decisions = ['allow_once', 'deny'];
    const seen = [];
    await session.start({
      permissionMode: 'ask',
      onEvent: (event) => {
        if (event.type !== 'approval') return;
        seen.push(event);
        event.respond(decisions.shift());
      },
    });
    const allowed = await session.prompt('run it [approve]');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'command');
    assert.match(seen[0].command || seen[0].title, /npm test/);
    assert.deepEqual(seen[0].options, ['allow_once', 'allow_always', 'deny']);
    assert.doesNotMatch(allowed.text, /denied/);
    const denied = await session.prompt('again [approve]');
    assert.match(denied.text, /denied|decline/);
  });

  test(`${name}: cancelling a turn rejects it as cancelled`, async (t) => {
    const { dir, env } = setup(t);
    const session = create({ cwd: dir, env });
    t.after(() => session.close());
    await session.start({ permissionMode: 'full' });
    const controller = new AbortController();
    const running = session.prompt('long one [slow]', { signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    await assert.rejects(running, (error) => error.code === CODES.CANCELLED);
    // The session still answers afterwards.
    const next = await session.prompt('after cancel [echo]');
    assert.match(next.text, /after cancel/);
  });

  test(`${name}: a failing turn reports the provider error`, async (t) => {
    const { dir, env } = setup(t);
    const session = create({ cwd: dir, env });
    t.after(() => session.close());
    await session.start({ permissionMode: 'full' });
    await assert.rejects(session.prompt('break [fail]'), (error) => error.code === CODES.PROVIDER_FAILED || error.code === CODES.RPC_ERROR);
  });

  test(`${name}: a session resumes by id in a new process`, async (t) => {
    const { dir, env, read } = setup(t);
    const first = create({ cwd: dir, env });
    const { sessionId } = await first.start({ permissionMode: 'ask' });
    await first.prompt('remember me');
    const id = first.sessionId || sessionId;
    await first.close();
    assert.ok(id, 'a session id');
    const second = create({ cwd: dir, env });
    t.after(() => second.close());
    const resumed = await second.start({ sessionId: id, permissionMode: 'ask' });
    assert.equal(resumed.resumed, true);
    assert.equal(second.sessionId, id);
    await until(() => read().some((entry) => entry.method === 'session/load' || entry.method === 'thread/resume' || entry.resume === id), { label: 'resume log' });
  });
}

test('acp: permission modes select the agent mode', async (t) => {
  const { dir, env, read } = setup(t);
  for (const [mode, expected] of [
    ['full', 'bypassPermissions'],
    ['workspace', 'acceptEdits'],
    ['plan', 'plan'],
  ]) {
    const session = createAcpSession({ binary: NODE, args: [fixture('mock-acp-agent.js')], cwd: dir, env });
    await session.start({ permissionMode: mode });
    await session.close();
    assert.equal(read().filter((entry) => entry.method === 'session/set_mode').at(-1)?.modeId, expected, mode);
  }
});

test('acp: an unauthenticated agent is reported as needing sign-in', async (t) => {
  const { dir, env } = setup(t, { MOCK_AUTH_FAIL: '1' });
  const session = createAcpSession({ binary: NODE, args: [fixture('mock-acp-agent.js')], cwd: dir, env });
  t.after(() => session.close());
  await assert.rejects(session.start({}), (error) => error.code === CODES.AUTH_REQUIRED);
});

test('acp: an unknown session starts over instead of failing', async (t) => {
  const { dir, env } = setup(t);
  const session = createAcpSession({ binary: NODE, args: [fixture('mock-acp-agent.js')], cwd: dir, env });
  t.after(() => session.close());
  const result = await session.start({ sessionId: 'not-a-real-session' });
  assert.equal(result.resumed, false);
  assert.notEqual(session.sessionId, 'not-a-real-session');
});

test('acp: a missing binary fails to start', async (t) => {
  const dir = tempDir(t);
  const session = createAcpSession({ binary: path.join(dir, 'missing-agent'), cwd: dir, env: process.env });
  await assert.rejects(session.start({}), (error) => [CODES.START_FAILED, CODES.CLOSED, CODES.PROCESS_EXITED].includes(error.code));
});

test('codex: modes map to approval policy and sandbox', async (t) => {
  const { dir, env, read } = setup(t);
  for (const mode of ['full', 'workspace', 'ask']) {
    const session = createCodexSession({ binary: NODE, args: [fixture('mock-codex.js')], cwd: dir, env });
    await session.start({ permissionMode: mode, model: 'gpt-test' });
    await session.close();
  }
  const starts = read().filter((entry) => entry.method === 'thread/start');
  assert.deepEqual(
    starts.map((entry) => [entry.approvalPolicy, entry.sandbox, entry.model]),
    [
      ['never', 'workspace-write', 'gpt-test'],
      ['on-request', 'workspace-write', 'gpt-test'],
      ['on-request', 'read-only', 'gpt-test'],
    ],
  );
});

test('codex: steering adds text to the running turn', async (t) => {
  const { dir, env } = setup(t);
  const session = createCodexSession({ binary: NODE, args: [fixture('mock-codex.js')], cwd: dir, env });
  t.after(() => session.close());
  await session.start({ permissionMode: 'full' });
  const running = session.prompt('start [steerable]');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await session.steer('also this'), true);
  const result = await running;
  assert.match(result.text, /\+steer\(also this\)/);
  assert.equal(await session.steer('nothing running'), false);
});

test('codex: usage is counted once per model request', async (t) => {
  const { dir, env } = setup(t);
  const session = createCodexSession({ binary: NODE, args: [fixture('mock-codex.js')], cwd: dir, env });
  t.after(() => session.close());
  const ev = events();
  await session.start({ permissionMode: 'full', onEvent: ev.onEvent });
  const result = await session.prompt('count');
  assert.equal(result.usage.total_tokens, 15);
  assert.equal(ev.of('usage').length, 1);
});

test('codex: MCP servers become -c TOML overrides', () => {
  const args = mcpConfigArgs([{ name: 'troupe', command: '/usr/bin/node', args: ['/x/troupe.js', 'mcp'], env: { TROUPE_MAILBOX: '/tmp/a "b"' } }]);
  assert.deepEqual(args, [
    '-c',
    'mcp_servers.troupe.command="/usr/bin/node"',
    '-c',
    'mcp_servers.troupe.args=["/x/troupe.js","mcp"]',
    '-c',
    'mcp_servers.troupe.env={TROUPE_MAILBOX="/tmp/a \\"b\\""}',
  ]);
  assert.throws(() => mcpConfigArgs([{ name: 'x', command: 'relative' }]), (error) => error.code === CODES.MCP_INVALID);
});

test('claude: plan mode and MCP config reach the command line', async (t) => {
  const { dir, env, read } = setup(t);
  const session = createClaudeSession({ binary: NODE, args: [fixture('mock-claude.js')], cwd: dir, env });
  t.after(() => session.close());
  await session.start({ permissionMode: 'plan', model: 'sonnet', mcpServers: [{ name: 'troupe', command: NODE, args: ['x'], env: { A: 'b' } }] });
  await until(() => read().some((entry) => entry.start));
  const start = read().find((entry) => entry.start);
  assert.equal(start.mode, 'plan');
  assert.equal(start.model, 'sonnet');
  assert.deepEqual(start.mcp, ['troupe']);
  assert.equal(start.strict, false);
  assert.match(mcpConfig([{ name: 'troupe', command: NODE }]), /"type":"stdio"/);
});

test('exec: one process per prompt, full mode only', async (t) => {
  const dir = tempDir(t);
  const session = createExecSession({
    binary: NODE,
    args: ['-e', 'console.log("exec says " + process.argv.at(-1))'],
    cwd: dir,
    env: process.env,
    label: 'Exec',
    exec: { args: ['{prompt}'] },
  });
  await assert.rejects(session.start({ permissionMode: 'ask' }), (error) => error.code === CODES.PLAN_DENIED);
  await session.start({ permissionMode: 'full' });
  const result = await session.prompt('ping');
  assert.equal(result.text, 'exec says ping');
});

test('exec: a non-zero exit is a provider failure with stderr', async (t) => {
  const dir = tempDir(t);
  const session = createExecSession({
    binary: NODE,
    args: ['-e', 'console.error("bad things"); process.exit(3)'],
    cwd: dir,
    env: process.env,
    exec: { args: ['{prompt}'] },
  });
  await session.start({ permissionMode: 'full' });
  await assert.rejects(session.prompt('x'), (error) => error.code === CODES.PROVIDER_FAILED && /bad things/.test(error.message));
});
