// The JSON Schemas in spec/schemas describe what the implementation really sends.
// A small validator for the keywords the schemas use keeps this dependency-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { Engine, METHODS } from '../src/engine/engine.js';
import { serveEngine } from '../src/engine/rpc.js';
import { normalizeGoal, approveGoal } from '../src/goals/goal.js';
import { evaluateGate } from '../src/goals/gate.js';
import { exchange } from '../src/collab/mcp-server.js';
import { MailboxHub } from '../src/collab/mailbox.js';
import { CODES } from '../src/protocol/errors.js';
import { ROOT, gitEnv, gitRepo, mockProviders, tempDir, until } from './helpers.js';

const schema = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'schemas', `${name}.schema.json`), 'utf8'));

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** Returns a list of problems (empty when valid). */
export function validate(s, value, at = '$') {
  const problems = [];
  const fail = (message) => problems.push(`${at}: ${message}`);
  if (s === true || s === undefined) return problems;
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const actual = typeOf(value);
    if (!types.some((type) => type === actual || (type === 'number' && actual === 'integer'))) return [`${at}: expected ${types.join('|')}, got ${actual}`];
  }
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(value)) fail(`expected ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) fail(`not one of ${s.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (s.pattern && !new RegExp(s.pattern).test(value)) fail(`does not match ${s.pattern}`);
    if (s.minLength !== undefined && value.length < s.minLength) fail('too short');
    if (s.maxLength !== undefined && value.length > s.maxLength) fail('too long');
  }
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) fail(`below ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) fail(`above ${s.maximum}`);
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) fail(`not above ${s.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (s.maxItems !== undefined && value.length > s.maxItems) fail('too many items');
    if (s.items) value.forEach((item, i) => problems.push(...validate(s.items, item, `${at}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of s.required || []) if (!(key in value)) fail(`missing ${key}`);
    for (const [key, sub] of Object.entries(s.properties || {})) if (key in value) problems.push(...validate(sub, value[key], `${at}.${key}`));
    if (s.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in (s.properties || {}))) fail(`unexpected ${key}`);
    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      for (const [key, item] of Object.entries(value)) if (!(key in (s.properties || {}))) problems.push(...validate(s.additionalProperties, item, `${at}.${key}`));
    }
  }
  if (s.not && validate(s.not, value, at).length === 0) fail('matches a forbidden shape');
  for (const part of s.allOf || []) {
    if (part.if) {
      if (validate(part.if, value, at).length === 0 && part.then) problems.push(...validate(part.then, value, at));
    } else problems.push(...validate(part, value, at));
  }
  if (s.oneOf) {
    const matches = s.oneOf.filter((option) => validate(option, value, at).length === 0).length;
    if (matches !== 1) fail(`matches ${matches} of oneOf`);
  }
  return problems;
}

test('goal documents from the implementation match goal.schema.json', async (t) => {
  const dir = tempDir(t);
  let goal = normalizeGoal({
    title: 'T',
    outcome: 'O',
    criteria: [
      { id: 'a', text: 'passes', check: { run: 'true', timeoutSec: 5, expect: { exitCode: 0, output: '.*' } } },
      { id: 'b', text: 'reviewed', review: { by: '@codex' } },
      { id: 'c', text: 'demoed' },
    ],
    boundaries: ['x'],
    questions: [{ text: 'q?', answer: 'yes' }],
    assignees: ['claude'],
  });
  goal = approveGoal(goal);
  const gate = await evaluateGate({ goal, agentName: 'claude', cwd: dir, projectRoot: dir, iteration: 1, review: async () => ({ passed: true, summary: 'ok' }) });
  goal = { ...goal, gates: [gate], confirmations: { c: true } };
  assert.deepEqual(validate(schema('goal'), goal), []);
  assert.ok(validate(schema('goal'), { ...goal, criteria: [{ id: 'x', text: 'y', check: { run: 'a' }, review: { by: 'b' } }] }).length > 0, 'check and review together are refused');
});

test('mailbox requests and responses match their schemas', async (t) => {
  const dir = tempDir(t);
  const seen = [];
  const hub = new MailboxHub({
    dir,
    pollMs: 20,
    handle: async (agentId, op, params) => {
      if (op === 'board_read') throw Object.assign(new Error('nope'), { code: CODES.BOARD_KEY_INVALID });
      return { echoed: params };
    },
  });
  t.after(() => hub.dispose());
  const { dir: box, token } = hub.register('agent-1');
  // Capture the request file as the MCP server writes it.
  const watcher = setInterval(() => {
    for (const name of fs.readdirSync(path.join(box, 'requests'))) {
      try {
        seen.push(JSON.parse(fs.readFileSync(path.join(box, 'requests', name), 'utf8')));
      } catch {
        /* claimed meanwhile */
      }
    }
  }, 2);
  const ok = await exchange({ dir: box, token, op: 'report_progress', params: { status: 'testing' }, waitSeconds: 0, pollMs: 20 });
  const bad = await exchange({ dir: box, token, op: 'board_read', params: { key: '!' }, waitSeconds: 0, pollMs: 20 });
  clearInterval(watcher);
  assert.deepEqual(validate(schema('mailbox-response'), ok), []);
  assert.deepEqual(validate(schema('mailbox-response'), bad), []);
  assert.equal(bad.error.code, 'CROSS_HARNESS_BOARD_KEY_INVALID');
  assert.ok(seen.length >= 1, 'saw a request on disk');
  for (const request of seen) assert.deepEqual(validate(schema('mailbox-request'), request), []);
});

test('engine events and client RPC messages match their schemas', async (t) => {
  const home = tempDir(t, 'cross-harness-home-');
  fs.mkdirSync(path.join(home, 'mock'));
  const repo = gitRepo(t);
  const env = { ...gitEnv(), CROSS_HARNESS_HOME: home, MOCK_STATE: path.join(home, 'mock') };
  const engine = await new Engine({ root: repo.dir, env, builtins: false, providers: mockProviders(), config: { providers: {}, defaults: { mode: 'ask', isolation: 'worktree', maxPerProvider: 3, idleMinutes: 15, gateTimeoutSec: 60, maxIterations: 5 }, lang: null } }).open();
  t.after(() => engine.close());
  // Drive the engine through its stdio protocol and record both directions.
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  void serveEngine(engine, { input, output });
  const sent = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { client: 'test' } },
    { jsonrpc: '2.0', id: 2, method: 'call', params: { method: 'send', params: { text: '@mock-acp go [approve]' } } },
  ];
  for (const message of sent) input.write(JSON.stringify(message) + '\n');
  const approval = await until(() => lines.find((m) => m.method === 'event' && m.params.event.type === 'approval.requested'), { label: 'approval event', timeoutMs: 20_000 });
  const answer = { jsonrpc: '2.0', id: 3, method: 'call', params: { method: 'approve', params: { id: approval.params.event.approval.id, choice: 'deny' } } };
  const unknown = { jsonrpc: '2.0', id: 4, method: 'call', params: { method: 'stop', params: { agent: 'ghost' } } };
  input.write(JSON.stringify(answer) + '\n');
  input.write(JSON.stringify(unknown) + '\n');
  await until(() => lines.some((m) => m.method === 'event' && m.params.event.type === 'agent.message' && m.params.event.entry.role === 'assistant'), { label: 'answer', timeoutMs: 20_000 });
  await until(() => lines.some((m) => m.id === 4), { label: 'error reply' });
  input.end();
  const rpc = schema('client-rpc');
  for (const message of [...sent, answer, unknown, ...lines]) assert.deepEqual(validate(rpc, message), [], JSON.stringify(message).slice(0, 200));
  const events = lines.filter((m) => m.method === 'event').map((m) => m.params.event);
  assert.ok(events.length > 5);
  for (const event of events) assert.deepEqual(validate(schema('engine-event'), event), [], event.type);
  assert.equal(lines.find((m) => m.id === 4).error.data.code, 'CROSS_HARNESS_AGENT_NOT_FOUND');
  // Every method the schema lists is reachable, and only those.
  assert.deepEqual(rpc.oneOf[1].properties.params.properties.method.enum, [...METHODS]);
  assert.ok(Readable);
});
