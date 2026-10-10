import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../src/engine/engine.js';
import { CODES } from '../src/protocol/errors.js';
import { NODE, gitEnv, gitRepo, mockProviders, tempDir, until } from './helpers.js';

async function open(t, { files, mode = 'workspace', git = true, providers = {} } = {}) {
  const home = tempDir(t, 'troupe-home-');
  const state = path.join(home, 'mock');
  fs.mkdirSync(state);
  const repo = git ? gitRepo(t, files) : { dir: tempDir(t), git: null };
  const env = { ...gitEnv(), TROUPE_HOME: home, MOCK_STATE: state, MOCK_LOG: path.join(home, 'mock.log') };
  const make = () =>
    new Engine({
      root: repo.dir,
      env,
      builtins: false,
      providers: { ...mockProviders(), ...providers },
      config: { providers: {}, defaults: { mode, isolation: 'worktree', maxPerProvider: 3, idleMinutes: 15, gateTimeoutSec: 60, maxIterations: 5 }, lang: null },
    });
  const engine = await make().open();
  const events = [];
  engine.subscribe((event) => events.push(event));
  t.after(() => engine.close());
  return { engine, events, repo, env, home, make };
}

const lastAssistant = (engine, name) => [...engine.agentByName(name).transcript].reverse().find((e) => e.role === 'assistant');
const idle = (engine, name) => until(() => engine.agentByName(name) && !engine.agentByName(name).busy && !engine.agentByName(name).queue.length && engine.agentByName(name).transcript.some((e) => e.role !== 'system' && e.role !== 'user'), { label: `@${name} idle`, timeoutMs: 20_000 });

test('one message reaches several agents, each in its own worktree', async (t) => {
  const { engine, events } = await open(t);
  const result = await engine.call('send', { text: '@mock-acp @mock-codex say hello' });
  assert.deepEqual(
    result.dispatched.map((d) => [d.agent, d.created, d.isolation]),
    [
      ['mock-acp', true, 'worktree'],
      ['mock-codex', true, 'worktree'],
    ],
  );
  await idle(engine, 'mock-acp');
  await idle(engine, 'mock-codex');
  assert.match(lastAssistant(engine, 'mock-acp').text, /mock-acp answered: say hello/);
  assert.match(lastAssistant(engine, 'mock-codex').text, /mock-codex answered: say hello/);
  const acp = engine.agentByName('mock-acp');
  // A brand-new agent has no earlier session to report on.
  assert.ok(!acp.transcript.some((e) => e.code === 'session-new' || e.code === 'session-resumed'));
  assert.match(acp.worktree.branch, /^troupe\/mock-acp/);
  assert.notEqual(acp.cwd, engine.root);
  assert.ok(events.some((e) => e.type === 'agent.text'));
  assert.ok(events.some((e) => e.type === 'agent.activity'));
  // A follow-up without mentions goes to the selected agent, in the same live session.
  const pid = acp.session.pid;
  await engine.call('send', { text: 'and again [echo]', to: 'mock-acp' });
  await until(() => lastAssistant(engine, 'mock-acp').text.includes('and again'), { label: 'follow-up' });
  assert.equal(acp.session.pid, pid);
  await assert.rejects(engine.call('send', { text: 'nobody named' }), (error) => error.code === CODES.NO_TARGET);
  await assert.rejects(engine.call('nope', {}), (error) => error.code === CODES.METHOD_UNKNOWN);
});

test('approvals: asked in ask mode, remembered with always-allow', async (t) => {
  const { engine, events } = await open(t, { mode: 'ask' });
  await engine.call('send', { text: '@mock-claude run the tests [approve]' });
  const requested = await until(() => events.find((e) => e.type === 'approval.requested'), { label: 'approval' });
  assert.equal(requested.approval.kind, 'command');
  assert.equal(requested.approval.agentName, 'mock-claude');
  assert.equal(engine.snapshot().agents[0].needsYou, 1);
  engine.call('approve', { id: requested.approval.id, choice: 'allow_always' });
  await idle(engine, 'mock-claude');
  assert.match(lastAssistant(engine, 'mock-claude').text, /npm test allowed/);
  assert.deepEqual(engine.agentByName('mock-claude').rules, [{ kind: 'command', prefix: 'npm test' }]);
  const before = events.filter((e) => e.type === 'approval.requested').length;
  await engine.call('send', { text: '@mock-claude again [approve]' });
  await until(() => engine.agentByName('mock-claude').transcript.filter((e) => e.role === 'assistant').length === 2, { label: 'second turn' });
  assert.equal(events.filter((e) => e.type === 'approval.requested').length, before, 'auto-allowed by the rule');
  assert.throws(() => engine.approve({ id: 'missing', choice: 'deny' }), (error) => error.code === CODES.APPROVAL_NOT_FOUND);
});

test('a harness without the default mode gets the closest lower one; a higher one is announced', async (t) => {
  const oneShot = (modes) => ({ name: 'One-shot', command: NODE, protocol: 'exec', exec: { args: ['-e', 'process.stdout.write(process.argv[1])', '{prompt}'] }, modes });
  const { engine, events } = await open(t, { providers: { once: oneShot(['full']), careful: oneShot(['plan', 'full']) } });
  assert.equal((await engine.call('createAgent', { provider: 'once' })).mode, 'full');
  assert.ok(engine.agentByName('once').transcript.some((e) => e.code === 'mode-raised'));
  assert.ok(events.some((e) => e.type === 'notice' && e.level === 'warn' && /@once: .*full mode and acts without asking/.test(e.text)));
  assert.equal((await engine.call('createAgent', { provider: 'careful' })).mode, 'plan');
  assert.ok(!engine.agentByName('careful').transcript.some((e) => e.code === 'mode-raised'));
  await assert.rejects(engine.call('createAgent', { provider: 'once', mode: 'ask' }), (error) => error.code === CODES.PLAN_DENIED);
});

test('workspace edits are automatic inside the worktree and asked outside it, for every protocol', async (t) => {
  const { engine, events } = await open(t);
  await engine.call('send', { text: '@mock-acp @mock-codex @mock-claude go [ask-edit:src/in.js] [ask-edit:../outside.js]' });
  const asked = await until(() => {
    const list = events.filter((e) => e.type === 'approval.requested');
    return list.length >= 3 && list;
  }, { label: 'three approvals', timeoutMs: 20_000 });
  for (const event of asked) {
    assert.match(`${event.approval.title} ${event.approval.detail}`, /outside\.js/);
    await engine.call('approve', { id: event.approval.id, choice: 'deny' });
  }
  for (const name of ['mock-acp', 'mock-codex', 'mock-claude']) {
    await idle(engine, name);
    assert.match(lastAssistant(engine, name).text, /\(edit src\/in\.js allowed\) \(edit \.\.\/outside\.js denied\)/, name);
  }
  assert.equal(events.filter((e) => e.type === 'approval.requested').length, 3);
});

test('plan mode denies commands without asking', async (t) => {
  const { engine, events } = await open(t, { mode: 'plan' });
  await engine.call('send', { text: '@mock-acp try it [approve]' });
  await idle(engine, 'mock-acp');
  assert.match(lastAssistant(engine, 'mock-acp').text, /denied/);
  assert.equal(events.filter((e) => e.type === 'approval.requested').length, 0);
});

test('what an agent writes, its worktree and its mailbox, is under one directory', async (t) => {
  const { engine } = await open(t);
  const view = await engine.call('createAgent', { provider: 'mock-codex' });
  const agent = engine.agents.get(view.id);
  const [server] = engine.collabServers(agent);
  const inside = (file) => file.startsWith(engine.worktreeRoot + path.sep);
  assert.ok(inside(agent.worktree.path), agent.worktree.path);
  assert.ok(inside(server.env.TROUPE_MAILBOX), server.env.TROUPE_MAILBOX);
  // The token registry stays with Troupe's own state, out of the agents' reach.
  assert.ok(fs.existsSync(path.join(engine.stateDir, 'mailbox-tokens.json')));
  assert.equal(fs.existsSync(path.join(engine.worktreeRoot, '.mailbox', 'tokens.json')), false);
});

test('agents ask each other through the collaboration tools', async (t) => {
  const { engine } = await open(t);
  await engine.call('createAgent', { provider: 'mock-codex' });
  await engine.call('send', { text: '@mock-acp coordinate [mcp:troupe_ask_agent {"agent":"mock-codex","question":"which port?","wait_seconds":30}]' });
  await until(() => lastAssistant(engine, 'mock-acp'), { label: 'asker answered', timeoutMs: 30_000 });
  const asker = lastAssistant(engine, 'mock-acp').text;
  assert.match(asker, /\[troupe_ask_agent\] @mock-codex answered:\nmock-codex answered: Question from @mock-acp/);
  const target = engine.agentByName('mock-codex').transcript;
  const question = target.find((e) => e.role === 'question');
  assert.equal(question.text, 'which port?');
  assert.equal(question.from.name, 'mock-acp');
});

test('agents ask the user, share a board and list each other', async (t) => {
  const { engine, events } = await open(t);
  await engine.call('createAgent', { provider: 'mock-codex' });
  await engine.call('send', {
    text: '@mock-acp plan [mcp:troupe_board_write {"key":"plan","value":"api first"}] [mcp:troupe_ask_user {"question":"Ship today?","options":["yes","no"],"wait_seconds":30}] [mcp:troupe_list_agents {}]',
  });
  const asked = await until(() => events.find((e) => e.type === 'decision.requested'), { label: 'decision', timeoutMs: 20_000 });
  assert.deepEqual(asked.decision.options, ['yes', 'no']);
  assert.equal(engine.snapshot().decisions.length, 1);
  engine.call('answerDecision', { id: asked.decision.id, answer: 'yes' });
  await until(() => lastAssistant(engine, 'mock-acp'), { label: 'answer', timeoutMs: 20_000 });
  const text = lastAssistant(engine, 'mock-acp').text;
  assert.match(text, /\[troupe_board_write\] Saved "plan"/);
  assert.match(text, /\[troupe_ask_user\] The user answered:\nyes/);
  assert.match(text, /\[troupe_list_agents\] - @mock-codex \(Mock Codex/);
  assert.equal(engine.snapshot().board.entries[0].author, 'mock-acp');
  await engine.call('send', { text: '@mock-codex read it [mcp:troupe_board_read {"key":"plan"}]' });
  await until(() => lastAssistant(engine, 'mock-codex'), { label: 'reader', timeoutMs: 20_000 });
  assert.match(lastAssistant(engine, 'mock-codex').text, /plan \(by mock-acp.*\):\napi first/);
});

test('diff, review and merge bring an agent\'s work back', async (t) => {
  const { engine, repo } = await open(t);
  await engine.call('send', { text: '@mock-acp write it [edit:feature.txt=from the agent]' });
  await idle(engine, 'mock-acp');
  const diff = await engine.call('diff', { agent: 'mock-acp' });
  assert.deepEqual(diff.files.map((f) => f.path), ['feature.txt']);
  assert.match(diff.patch, /\+from the agent/);
  const verdict = await engine.call('review', { agent: 'mock-acp', reviewer: 'mock-codex' });
  assert.equal(verdict.reviewer, 'mock-codex');
  assert.equal(verdict.passed, false, 'the mock reviewer never writes a verdict line');
  const merged = await engine.call('merge', { agent: 'mock-acp' });
  assert.equal(merged.target, 'main');
  assert.equal(fs.readFileSync(path.join(repo.dir, 'feature.txt'), 'utf8'), 'from the agent\n');
  await assert.rejects(engine.call('merge', { agent: 'mock-acp' }), (error) => error.code === CODES.MERGE_NOTHING);
});

test('the review names its reviewer before the verdict and messages carry their parameters', async (t) => {
  const { engine, events } = await open(t);
  await engine.call('send', { text: '@mock-acp write it [edit:feature.txt=from the agent]' });
  await idle(engine, 'mock-acp');
  const author = engine.agentByName('mock-acp');
  const created = author.transcript.find((e) => e.code === 'created');
  assert.deepEqual(created.params, { branch: author.worktree.branch });
  await engine.call('review', { agent: 'mock-acp', reviewer: 'mock-codex' });
  const started = events.findIndex((e) => e.type === 'review.started');
  assert.ok(started >= 0, 'review.started was sent');
  assert.equal(events[started].agentId, author.id);
  assert.equal(events[started].reviewer, 'mock-codex');
  const answered = events.findIndex((e) => e.type === 'agent.message' && e.entry.role === 'assistant' && e.agentId === engine.agentByName('mock-codex').id);
  assert.ok(started < answered, 'the reviewer is named before it answers');
  const request = engine.agentByName('mock-codex').transcript.find((e) => e.role === 'review');
  assert.deepEqual([request.key, request.params], ['review', { name: 'mock-acp' }]);
});

test('a project opened through a symbolic link gives agents their worktree', async (t) => {
  const repo = gitRepo(t);
  const link = path.join(tempDir(t, 'troupe-link-'), 'project');
  fs.symlinkSync(repo.dir, link);
  const home = tempDir(t, 'troupe-home-');
  const state = path.join(home, 'mock');
  fs.mkdirSync(state);
  const engine = await new Engine({
    root: link,
    env: { ...gitEnv(), TROUPE_HOME: home, MOCK_STATE: state, MOCK_LOG: path.join(home, 'mock.log') },
    builtins: false,
    providers: mockProviders(),
    config: { providers: {}, defaults: { mode: 'workspace', isolation: 'worktree', maxPerProvider: 3, idleMinutes: 15, gateTimeoutSec: 60, maxIterations: 5 }, lang: null },
  }).open();
  t.after(() => engine.close());
  await engine.call('send', { text: '@mock-acp write it [edit:linked.txt=through the link]' });
  await idle(engine, 'mock-acp');
  const agent = engine.agentByName('mock-acp');
  assert.equal(agent.cwd, agent.worktree.path);
  assert.equal(agent.state, 'idle');
  assert.equal(fs.readFileSync(path.join(agent.worktree.path, 'linked.txt'), 'utf8'), 'through the link\n');
});

test('a goal runs, is checked by Troupe and is met', async (t) => {
  const { engine, events, repo } = await open(t);
  const draft = await engine.call('goalSave', {
    goal: {
      title: 'Create done.txt',
      outcome: 'The marker file exists [edit:done.txt=ok]',
      criteria: [{ id: 'marker', text: 'done.txt exists', check: { run: 'test -f done.txt' } }],
      assignees: ['mock-acp'],
    },
  });
  await assert.rejects(engine.call('goalStart', { id: draft.id }), (error) => error.code === CODES.GATE_NOT_ARMED);
  await assert.rejects(engine.call('goalCheck', { id: draft.id }), (error) => error.code === CODES.GATE_NOT_ARMED, 'unapproved check commands never run');
  await engine.call('goalApprove', { id: draft.id });
  await engine.call('goalStart', { id: draft.id });
  const gate = await until(() => events.find((e) => e.type === 'gate.result'), { label: 'gate', timeoutMs: 20_000 });
  assert.equal(gate.gate.passed, true);
  assert.equal(engine.goals.get(draft.id).status, 'met');
  const agent = engine.agentByName('mock-acp');
  assert.equal(agent.goalId, draft.id);
  assert.ok(agent.transcript.some((e) => e.role === 'gate'));
  // Work that changed after the check does not merge until it is checked again.
  fs.writeFileSync(path.join(agent.worktree.path, 'late.txt'), 'unchecked\n');
  await assert.rejects(engine.call('merge', { agent: 'mock-acp' }), (error) => error.code === CODES.GATE_FAILED);
  const [again] = await engine.call('goalCheck', { id: draft.id });
  assert.equal(again.passed, true);
  // A passing gate on the current tree lets the merge through.
  const merged = await engine.call('merge', { agent: 'mock-acp' });
  assert.equal(merged.target, 'main');
  assert.ok(fs.existsSync(path.join(repo.dir, 'late.txt')));
});

test('a failing goal feeds the failures back until the iteration limit', async (t) => {
  const { engine, events } = await open(t);
  const goal = await engine.call('goalSave', {
    goal: { title: 'Impossible', outcome: 'never', criteria: [{ id: 'never', text: 'false passes', check: { run: 'echo nope; exit 1' } }], assignees: ['mock-codex'], maxIterations: 2 },
  });
  await engine.call('goalApprove', { id: goal.id });
  await engine.call('goalStart', { id: goal.id });
  await until(() => engine.goals.get(goal.id).status === 'needs-you', { label: 'needs-you', timeoutMs: 30_000 });
  const gates = events.filter((e) => e.type === 'gate.result');
  assert.equal(gates.length, 2);
  const feedback = engine.agentByName('mock-codex').transcript.filter((e) => e.role === 'feedback');
  assert.equal(feedback.length, 1);
  await assert.rejects(engine.call('merge', { agent: 'mock-codex' }), (error) => [CODES.GATE_FAILED, CODES.MERGE_NOTHING].includes(error.code));
});

test('stop ends the turn and the process; state survives a restart', async (t) => {
  const { engine, make } = await open(t);
  await engine.call('send', { text: '@mock-acp think hard [slow]' });
  const agent = await until(() => engine.agentByName('mock-acp')?.current && engine.agentByName('mock-acp'), { label: 'running' });
  await until(() => agent.session?.alive, { label: 'live session' });
  const sessionId = agent.sessionId;
  await engine.call('stop', { agent: 'mock-acp' });
  await until(() => agent.transcript.some((e) => e.code === 'stopped'), { label: 'stopped entry' });
  assert.equal(agent.view().state, 'stopped');
  assert.equal(agent.session, null);
  await engine.close();
  const again = await make().open();
  t.after(() => again.close());
  const restored = again.agentByName('mock-acp');
  assert.equal(restored.sessionId, sessionId);
  assert.ok(restored.transcript.some((e) => e.code === 'stopped'));
  await again.call('send', { text: '@mock-acp continue [echo]' });
  await until(() => restored.transcript.some((e) => e.code === 'session-resumed'), { label: 'resumed', timeoutMs: 20_000 });
});

test('a second engine on the same project is refused', async (t) => {
  const { make } = await open(t);
  await assert.rejects(make().open(), (error) => error.code === CODES.LOCKED);
});

test('@compare sends every answer to a judge', async (t) => {
  const { engine } = await open(t);
  const result = await engine.call('send', { text: '@mock-acp @mock-codex @compare:mock-claude which sort is fastest' });
  assert.deepEqual(result.dispatched.map((d) => d.agent), ['mock-acp', 'mock-codex', 'mock-claude']);
  await until(() => engine.agentByName('mock-claude').transcript.some((e) => e.role === 'assistant'), { label: 'judge', timeoutMs: 20_000 });
  const compare = engine.agentByName('mock-claude').transcript.find((e) => e.role === 'compare');
  assert.match(compare.text, /Compare 2 answers/);
});

test('plain directories work without isolation', async (t) => {
  const { engine } = await open(t, { git: false });
  const result = await engine.call('send', { text: '@mock-acp hello' });
  assert.equal(result.dispatched[0].isolation, 'shared');
  await idle(engine, 'mock-acp');
  await assert.rejects(engine.call('merge', { agent: 'mock-acp' }), (error) => error.code === CODES.MERGE_NOTHING);
});
