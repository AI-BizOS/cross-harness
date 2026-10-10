import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createDecoder } from '../src/tui/terminal.js';
import { Screen, fitSpans, plain, renderLine, span, spansWidth } from '../src/tui/screen.js';
import { Editor } from '../src/tui/editor.js';
import { createStore } from '../src/tui/store.js';
import { frameText, renderApp, sliceSpans } from '../src/tui/views.js';
import { runTui } from '../src/tui/app.js';
import { Engine } from '../src/engine/engine.js';
import { localClient } from '../src/engine/rpc.js';
import { displayWidth } from '../src/util/width.js';
import { setLang, t } from '../src/i18n/index.js';
import { REPOSITORY_URL, createStarPrompt } from '../src/star.js';
import { gitEnv, gitRepo, mockProviders, tempDir, until } from './helpers.js';

const strip = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function decode(chunks, { flush = false } = {}) {
  const keys = [];
  const timers = [];
  const decoder = createDecoder((key) => keys.push(key), { setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} });
  for (const chunk of chunks) decoder.feed(chunk);
  if (flush) timers.forEach((fn) => fn());
  return keys.map(({ name, text, ctrl, meta, shift }) => [name, text ?? '', ctrl, meta, shift]);
}

test('decoder: text, controls, arrows with modifiers, alt keys', () => {
  assert.deepEqual(decode(['ab中文😀']), [['text', 'ab中文😀', false, false, false]]);
  assert.deepEqual(decode(['\r', '\x1b\r', '\n', '\t', '\x7f', '\x03', '\x17']).map((k) => [k[0], k[2], k[3]]), [
    ['enter', false, false],
    ['newline', false, true],
    ['newline', false, false],
    ['tab', false, false],
    ['backspace', false, false],
    ['c', true, false],
    ['w', true, false],
  ]);
  assert.deepEqual(decode(['\x1b[A\x1b[1;5C\x1bOB\x1b[5~\x1b[3~\x1b[Z']).map((k) => [k[0], k[2], k[4]]), [
    ['up', false, false],
    ['right', true, false],
    ['down', false, false],
    ['pageup', false, false],
    ['delete', false, false],
    ['tab', false, true],
  ]);
  assert.deepEqual(decode(['\x1bb', '\x1b\x7f']).map((k) => [k[0], k[3]]), [
    ['b', true],
    ['backspace', true],
  ]);
  // CSI u (kitty) shift+enter, and mouse reports are ignored.
  assert.deepEqual(decode(['\x1b[13;2u', '\x1b[<0;10;5M']).map((k) => k[0]), ['newline']);
});

test('decoder: lone escape waits for the timeout; split sequences join', () => {
  assert.deepEqual(decode(['\x1b']), []);
  assert.deepEqual(decode(['\x1b'], { flush: true }).map((k) => k[0]), ['escape']);
  assert.deepEqual(decode(['\x1b', '[A']).map((k) => k[0]), ['up']);
  assert.deepEqual(decode(['\x1b[1', ';5D']).map((k) => [k[0], k[2]]), [['left', true]]);
});

test('decoder: bracketed paste, also across chunks', () => {
  assert.deepEqual(decode(['\x1b[200~line 1\r\nline 2\x1b[201~']), [['paste', 'line 1\nline 2', false, false, false]]);
  assert.deepEqual(decode(['x\x1b[200~par', 'tial \x1b[2', '01~y']), [
    ['text', 'x', false, false, false],
    ['paste', 'partial ', false, false, false],
    ['text', 'y', false, false, false],
  ]);
});

test('spans fit by display width, CJK and emoji included', () => {
  const line = [span('中文', 'bold'), span('abc'), span('😀')];
  assert.equal(spansWidth(line), 9);
  assert.equal(plain(fitSpans(line, 12)), '中文abc😀   ');
  assert.equal(plain(fitSpans(line, 6)), '中文a…');
  assert.equal(displayWidth(plain(fitSpans(line, 6))), 6);
  // A wide character that would straddle the edge is dropped, keeping the width exact.
  assert.equal(displayWidth(plain(fitSpans([span('中文字')], 5))), 5);
  assert.equal(plain(fitSpans([span('中文字')], 5, { ellipsis: false })), '中文 ');
  assert.equal(plain(sliceSpans([span('a中b')], 2, 4)), ' b');
  assert.equal(displayWidth(plain(sliceSpans([span('中文')], 1, 3))), 2);
  // Control characters and escapes never reach the terminal.
  assert.equal(span('a\x1b[31mb\x07').text, 'a[31mb');
  const colored = renderLine([span('x', 'bold', 'red')], 3);
  assert.match(colored, /\x1b\[1;31mx\x1b\[0m {2}$/);
  assert.match(renderLine([span('x', 'bold', 'red')], 3, { color: false }), /\x1b\[1mx/);
});

test('screen redraws only changed rows inside a synchronized update', () => {
  let out = '';
  const term = { size: () => ({ columns: 4, rows: 3 }), write: (s) => (out += s) };
  const screen = new Screen(term);
  screen.draw(['aaaa', 'bbbb', 'cccc']);
  assert.match(out, /^\x1b\[\?2026h/);
  assert.match(out, /\x1b\[\?2026l$/);
  out = '';
  screen.draw(['aaaa', 'BBBB', 'cccc'], { row: 1, col: 2 });
  assert.ok(out.includes('\x1b[2;1HBBBB'));
  assert.ok(!out.includes('aaaa'));
  assert.ok(out.includes('\x1b[2;3H\x1b[?25h'));
  out = '';
  screen.draw(['aaaa', 'BBBB', 'cccc'], { row: 1, col: 2 });
  assert.equal(out, '', 'an unchanged frame writes nothing');
  screen.draw(['aaaa', 'BBBB', 'cccc']);
  assert.equal(out, '\x1b[?2026h\x1b[?25l\x1b[?2026l', 'hiding the cursor is a change');
});

test('editor: grapheme-safe editing, words, kill keys, history', () => {
  const e = new Editor();
  e.insert('hi 👨‍👩‍👧 中');
  e.left();
  e.left();
  e.left();
  e.backspace();
  assert.equal(e.text, 'hi👨‍👩‍👧 中');
  e.end();
  e.backspace();
  assert.equal(e.text, 'hi👨‍👩‍👧 ');
  e.setText('alpha beta gamma');
  e.wordLeft();
  e.deleteWordBack();
  assert.equal(e.text, 'alpha gamma');
  e.home();
  e.killToEnd();
  assert.equal(e.text, '');
  e.setText('first');
  e.submit();
  e.setText('second');
  e.submit();
  e.insert('draft');
  assert.ok(e.up());
  assert.equal(e.text, 'second');
  e.up();
  assert.equal(e.text, 'first');
  e.down();
  e.down();
  assert.equal(e.text, 'draft');
  e.setText('line one\nline two');
  e.up();
  assert.equal(e.text.slice(0, e.cursor), 'line one');
});

test('editor: @ completion only in the leading mentions of a line', () => {
  const e = new Editor();
  e.insert('@codex @cl');
  assert.deepEqual(e.mentionToken(), { prefix: '@cl', start: 7, end: 10 });
  assert.ok(e.complete('claude'));
  assert.equal(e.text, '@codex @claude ');
  e.insert('review\n@ki');
  assert.equal(e.mentionToken().prefix, '@ki');
  e.setText('mail @codex');
  assert.equal(e.mentionToken(), null);
});

test('editor: layout wraps CJK text and places the cursor', () => {
  const e = new Editor();
  e.insert('你好世界abc');
  const layout = e.layout(8, 2);
  assert.deepEqual(layout.rows, ['你好世', '界abc']);
  assert.deepEqual([layout.cursorRow, layout.cursorCol], [1, 2 + 5]);
  e.setText('abcdef');
  const full = e.layout(8, 2);
  assert.deepEqual(full.rows, ['abcdef', '']);
  assert.deepEqual([full.cursorRow, full.cursorCol], [1, 2]);
});

function sampleSnapshot() {
  const now = new Date().toISOString();
  return {
    protocol: 'cross-harness/1',
    version: '0.1.0',
    seq: 10,
    project: { root: '/work/shop', name: 'shop', isGit: true, branch: 'main' },
    defaults: { mode: 'workspace' },
    agents: [
      { id: 'a1111111-0000-0000-0000-000000000000', id8: 'a1111111', name: 'codex', provider: 'codex', providerName: 'Codex', verified: true, mode: 'workspace', branch: 'cross-harness/codex', state: 'running', needsYou: 1, queue: 0, plan: [], text: '', usage: { input_tokens: 1200, output_tokens: 300 }, activity: { kind: 'command', title: 'npm test' }, turnStartedAt: Date.now() - 65_000 },
      { id: 'b2222222-0000-0000-0000-000000000000', id8: 'b2222222', name: 'kimi', provider: 'kimi', providerName: 'Kimi Code', verified: false, mode: 'ask', branch: 'cross-harness/kimi', state: 'idle', needsYou: 0, queue: 0, plan: [], text: '', usage: {}, progress: '写好了边界测试' },
    ],
    approvals: [{ id: 'ap1', agentId: 'a1111111-0000-0000-0000-000000000000', agentName: 'codex', kind: 'command', title: 'npm test', command: 'npm test -- --watch=false', detail: 'run the tests', options: ['allow_once', 'allow_always', 'deny'], at: now }],
    decisions: [],
    board: { entries: [{ key: 'plan', value: 'API first, then UI', author: 'codex', at: now }] },
    goals: [{ id: 'goal-1', title: 'Fix parser', outcome: 'errors show line numbers', status: 'running', revision: 2, approvedRevision: 2, criteria: [{ id: 'tests', text: 'tests pass', check: { run: 'npm test' } }], assignees: ['codex'], boundaries: [], questions: [], gates: [], updatedAt: now }],
    providers: [{ id: 'claude', name: 'Claude Code', available: true, verified: true, version: '2.1.0', protocol: 'claude-stream' }],
  };
}

function uiState(store) {
  return { focus: 'composer', selected: 'b2222222-0000-0000-0000-000000000000', editor: new Editor(), completion: null, scroll: new Map(), modal: null, notice: null, wrapCache: new Map(), remote: false };
}

test('store applies a snapshot and events in order', () => {
  const store = createStore();
  store.applySnapshot(sampleSnapshot());
  assert.equal(store.counts().working, 1);
  assert.equal(store.counts().waiting, 1);
  assert.equal(store.applyEvent({ seq: 5, type: 'notice', level: 'info', text: 'old' }), false, 'older than the snapshot');
  store.applyEvent({ seq: 11, type: 'agent.message', agentId: 'b2222222-0000-0000-0000-000000000000', entry: { id: 'm1', at: '2026-10-09T00:00:01Z', role: 'assistant', text: 'done' } });
  store.applyEvent({ seq: 12, type: 'approval.resolved', id: 'ap1', choice: 'allow_once' });
  store.applyEvent({ seq: 13, type: 'agent.activity', agentId: 'a1111111-0000-0000-0000-000000000000', activity: { id: 'x', kind: 'edit', title: 'src/a.js', status: 'running' } });
  assert.equal(store.counts().waiting, 0);
  assert.equal(store.state.live.get('a1111111-0000-0000-0000-000000000000').activities.size, 1);
  store.setTranscript('b2222222-0000-0000-0000-000000000000', [{ id: 'm0', at: '2026-10-09T00:00:00Z', role: 'user', text: 'hi' }]);
  assert.deepEqual(store.state.transcripts.get('b2222222-0000-0000-0000-000000000000').map((e) => e.id), ['m0', 'm1']);
  store.applyEvent({ seq: 14, type: 'goal.updated', goal: { id: 'goal-1', deleted: true } });
  assert.equal(store.goals().length, 0);
});

test('the screen renders agents, transcript, approvals and the composer at exact widths', () => {
  setLang('en');
  const store = createStore();
  store.applySnapshot(sampleSnapshot());
  store.setTranscript('b2222222-0000-0000-0000-000000000000', [
    { id: 'e1', at: '1', role: 'user', text: '为 parser 补充边界测试' },
    { id: 'e2', at: '2', role: 'assistant', text: 'Added 4 tests.\n```js\nexpect(parse("")).toThrow()\n```', durationMs: 42_000, activities: [{ kind: 'edit', title: 'test/parser.test.js', status: 'done' }] },
  ]);
  const ui = uiState(store);
  const size = { columns: 100, rows: 28 };
  const out = renderApp({ store, ui, size, t, now: Date.now(), frame: 0 });
  assert.equal(out.rows.length, 28);
  for (const row of out.rows) assert.equal(displayWidth(strip(row)), 100);
  const text = frameText(out.rows);
  assert.match(text, /cross-harness │ shop \(main\)/);
  assert.match(text, /2 agents\s+·\s+1 working\s+·\s+1 need you/);
  assert.match(text, /@codex/);
  assert.match(text, /\$ npm test/);
  assert.match(text, /写好了边界测试/);
  assert.match(text, /为 parser 补充边界测试/);
  assert.match(text, /Added 4 tests\./);
  assert.match(text, /✓ ✎ test\/parser\.test\.js/);
  assert.match(text, /@kimi · Kimi Code · untested · ask · cross-harness\/kimi/);
  assert.match(text, /Message @kimi/);
  assert.ok(out.cursor, 'cursor in the composer');
  // Narrow terminals drop the sidebar but keep exact widths.
  const narrow = renderApp({ store, ui, size: { columns: 50, rows: 20 }, t, now: Date.now(), frame: 0 });
  for (const row of narrow.rows) assert.equal(displayWidth(strip(row)), 50);
});

test('modals: approval, diff, goals and help render inside the frame', () => {
  setLang('zh');
  const store = createStore();
  store.applySnapshot(sampleSnapshot());
  const ui = uiState(store);
  const size = { columns: 90, rows: 30 };
  ui.modal = { type: 'waiting', index: 0, input: new Editor() };
  let text = frameText(renderApp({ store, ui, size, t, now: Date.now(), frame: 0 }).rows);
  assert.match(text, /需要你批准/);
  assert.match(text, /npm test -- --watch=false/);
  assert.match(text, /\[2\] 以后都允许 @codex 这样做/);
  ui.modal = { type: 'diff', agentName: 'kimi', branch: 'cross-harness/kimi', scroll: 0, diff: { isolated: true, base: 'main', commits: 1, uncommitted: true, files: [{ path: 'a.js', status: 'modified', added: 1, removed: 1 }], patch: 'diff --git a/a.js b/a.js\n-old\n+new' } };
  text = frameText(renderApp({ store, ui, size, t, now: Date.now(), frame: 0 }).rows);
  assert.match(text, /@kimi 的改动/);
  assert.match(text, /cross-harness\/kimi → main · 1 个提交 · 包含未提交的改动/);
  assert.match(text, /\+new/);
  ui.modal = { type: 'goals', index: 0 };
  text = frameText(renderApp({ store, ui, size, t, now: Date.now(), frame: 0 }).rows);
  assert.match(text, /Fix parser · 进行中/);
  assert.match(text, /运行：npm test/);
  ui.modal = { type: 'help' };
  const out = renderApp({ store, ui, size, t, now: Date.now(), frame: 0 });
  for (const row of out.rows) assert.equal(displayWidth(strip(row)), 90);
  setLang('en');
});

/** A terminal that records output and lets the test press keys. */
class FakeTerminal extends EventEmitter {
  constructor(columns = 100, rows = 30) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.output = '';
    this.screen = Array(rows).fill('');
    this.started = false;
  }
  size() {
    return { columns: this.columns, rows: this.rows };
  }
  write(text) {
    this.output += text;
    for (const match of text.matchAll(/\x1b\[(\d+);1H([^\x1b]*(?:\x1b\[[0-9;]*m[^\x1b]*)*)/g)) this.screen[Number(match[1]) - 1] = strip(match[2]);
  }
  text() {
    return this.screen.join('\n');
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
  }
  suspend() {}
  resume() {}
  type(text) {
    this.emit('key', { name: 'text', text, ctrl: false, meta: false, shift: false });
  }
  press(name, extra = {}) {
    this.emit('key', { name, ctrl: false, meta: false, shift: false, ...extra });
  }
}

test('the TUI drives a real engine: send, approve, view the diff, merge, quit', async (t2) => {
  setLang('en');
  const home = tempDir(t2, 'cross-harness-home-');
  fs.mkdirSync(path.join(home, 'mock'));
  const repo = gitRepo(t2);
  const env = { ...gitEnv(), CROSS_HARNESS_HOME: home, MOCK_STATE: path.join(home, 'mock') };
  const engine = await new Engine({ root: repo.dir, env, builtins: false, providers: mockProviders(), config: { providers: {}, defaults: { mode: 'ask', isolation: 'worktree', maxPerProvider: 3, idleMinutes: 15, gateTimeoutSec: 60, maxIterations: 5 }, lang: null } }).open();
  t2.after(() => engine.close());
  const term = new FakeTerminal(110, 32);
  const done = runTui({ client: localClient(engine), lang: 'en', terminal: term, env: { ...env, NO_COLOR: '' } });
  await until(() => term.started && term.text().includes('No agents yet'), { label: 'welcome screen' });
  term.type('@mock-acp write it [edit:feature.txt=hello] [approve]');
  term.press('enter');
  // The approval opens by itself because the composer is empty.
  await until(() => term.text().includes('Needs your approval'), { label: 'approval modal', timeoutMs: 20_000 });
  assert.match(term.text(), /npm test/);
  term.type('1');
  await until(() => term.text().includes('mock-acp answered: write it'), { label: 'answer', timeoutMs: 20_000 });
  term.press('escape');
  term.type('d');
  await until(() => term.text().includes('Changes by @mock-acp') && term.text().includes('feature.txt'), { label: 'diff', timeoutMs: 20_000 });
  term.type('m');
  await until(() => term.text().includes('Merge now without review'), { label: 'merge menu' });
  term.press('down');
  term.press('enter');
  await until(() => fs.existsSync(path.join(repo.dir, 'feature.txt')), { label: 'merged', timeoutMs: 20_000 });
  await until(() => term.text().includes('Merged cross-harness/mock-acp'), { label: 'merge notice' });
  term.type('q');
  await done;
  assert.equal(term.started, false);
});

test('the TUI mentions a newer release once and keeps it in the header', async (t2) => {
  setLang('en');
  const home = tempDir(t2, 'cross-harness-home-');
  const repo = gitRepo(t2);
  const env = { ...gitEnv(), CROSS_HARNESS_HOME: home };
  const engine = await new Engine({ root: repo.dir, env, builtins: false, providers: mockProviders(), config: { providers: {}, defaults: { mode: 'ask', isolation: 'worktree', maxPerProvider: 3, idleMinutes: 15, gateTimeoutSec: 60, maxIterations: 5 }, lang: null } }).open();
  t2.after(() => engine.close());
  const term = new FakeTerminal(120, 30);
  const update = { check: async () => ({ current: '0.1.3', latest: '0.2.0' }) };
  const done = runTui({ client: localClient(engine), lang: 'en', terminal: term, env: { ...env, NO_COLOR: '' }, update });
  await until(() => term.text().includes('cross-harness 0.2.0 is available (you have 0.1.3). Run `cross-harness update` to install it.'), { label: 'update notice' });
  assert.match(term.text().split('\n')[0], /↑ cross-harness 0\.2\.0/);
  term.press('escape');
  term.type('q');
  await done;
});

test('the TUI asks once for a GitHub star, opens the page on Enter and remembers it', async (t2) => {
  setLang('en');
  const home = tempDir(t2, 'cross-harness-home-');
  const repo = gitRepo(t2);
  const env = { ...gitEnv(), CROSS_HARNESS_HOME: home };
  const engine = await new Engine({ root: repo.dir, env, builtins: false, providers: mockProviders(), config: { providers: {}, defaults: { mode: 'ask', isolation: 'worktree', maxPerProvider: 3, idleMinutes: 15, gateTimeoutSec: 60, maxIterations: 5 }, lang: null } }).open();
  t2.after(() => engine.close());
  const star = createStarPrompt({ file: path.join(home, 'star.json') });
  star.opened();
  star.opened();
  const opened = [];
  const start = () => {
    const term = new FakeTerminal(100, 30);
    const done = runTui({ client: localClient(engine), lang: 'en', terminal: term, env: { ...env, NO_COLOR: '' }, star, openUrl: (url) => opened.push(url) });
    return { term, done };
  };
  // The third launch asks.
  const first = start();
  await until(() => first.term.text().includes('Enjoying cross-harness?'), { label: 'star prompt' });
  assert.match(first.term.text(), /github\.com\/AI-BizOS\/cross-harness/);
  first.term.press('enter');
  await until(() => !first.term.text().includes('Enjoying cross-harness?'), { label: 'prompt closed' });
  assert.deepEqual(opened, [REPOSITORY_URL]);
  first.term.press('escape');
  first.term.type('q');
  await first.done;
  // Answered: later launches do not ask again.
  const second = start();
  await until(() => second.term.text().includes('No agents yet'), { label: 'welcome screen' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.doesNotMatch(second.term.text(), /Enjoying cross-harness/);
  second.term.press('escape');
  second.term.type('q');
  await second.done;
});

