// The terminal UI: keys → actions on an engine client (local or remote), engine
// events → store → a redraw at most ~30 times a second.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { armProblems } from '../goals/goal.js';
import { setLang, t } from '../i18n/index.js';
import { engineText } from '../i18n/strings.js';
import { CODES } from '../protocol/errors.js';
import { PERMISSION_MODES } from '../protocol/index.js';
import { Editor } from './editor.js';
import { Screen, colorEnabled } from './screen.js';
import { createStore } from './store.js';
import { Terminal } from './terminal.js';
import { renderApp } from './views.js';

const FRAME_MS = 33;
const SPIN_MS = 100;
const NOTICE_MS = 6000;
const ARM_MS = 3000;

const GOAL_TEMPLATE = {
  title: '',
  outcome: '',
  criteria: [
    { id: 'tests', text: 'The test suite passes', check: { run: 'npm test' } },
    { id: 'review', text: 'Another agent reviews the change and finds no blocking problem', review: { by: 'codex' } },
  ],
  boundaries: [],
  questions: [],
  assignees: ['claude'],
  maxIterations: 5,
};

/**
 * @param {{client:{call:Function, subscribe:Function, remote?:boolean}, lang?:string, terminal?:object, env?:NodeJS.ProcessEnv, now?:()=>number, editJson?:Function, star?:object|null, update?:object|null, openUrl?:Function|null}} options
 *   `star` is the GitHub star prompt (src/star.js); `openUrl` opens its link in a browser;
 *   `update` checks for a newer release (src/update.js).
 * @returns {Promise<void>} resolves when the user quits
 */
export async function runTui({ client, lang = 'en', terminal = null, env = process.env, now = () => Date.now(), editJson = null, star = null, update = null, openUrl = null }) {
  setLang(lang);
  const term = terminal || new Terminal({ env });
  const screen = new Screen(term);
  const store = createStore();
  const color = colorEnabled(env);
  const ui = {
    focus: 'composer',
    selected: null,
    editor: new Editor(),
    completion: null,
    scroll: new Map(),
    modal: null,
    notice: null,
    quitArmedAt: 0,
    archiveArmed: null,
    wrapCache: new Map(),
    remote: Boolean(client.remote),
    layout: null,
  };
  let frame = 0;
  let renderTimer = null;
  let lastRender = 0;
  let closed = false;
  let resolveDone;
  const done = new Promise((resolve) => (resolveDone = resolve));

  store.applySnapshot(await client.call('snapshot'));

  // ── helpers ────────────────────────────────────────────────────────────

  function schedule() {
    if (closed || renderTimer) return;
    const wait = Math.max(0, FRAME_MS - (now() - lastRender));
    renderTimer = setTimeout(render, wait);
  }

  function render() {
    renderTimer = null;
    if (closed) return;
    lastRender = now();
    const out = renderApp({ store, ui, size: term.size(), t, now: now(), frame, color });
    ui.layout = out.layout;
    screen.draw(out.rows, out.cursor);
  }

  function notice(level, text) {
    ui.notice = { level, text, until: now() + NOTICE_MS };
    schedule();
  }

  async function act(promise, onDone) {
    try {
      const result = await promise;
      onDone?.(result);
      return result;
    } catch (error) {
      notice('error', `${t('error.prefix')}: ${error.message}`);
      return null;
    } finally {
      schedule();
    }
  }

  function selectedAgent() {
    return ui.selected ? store.state.agents.get(ui.selected) || null : null;
  }

  function loadTranscript(agentId) {
    if (!agentId || store.state.loaded.has(agentId)) return;
    store.state.loaded.add(agentId);
    client
      .call('transcript', { agent: agentId, limit: 300 })
      .then((result) => {
        store.setTranscript(agentId, result.entries);
        schedule();
      })
      .catch(() => store.state.loaded.delete(agentId));
  }

  function select(agentId) {
    ui.selected = agentId;
    loadTranscript(agentId);
    schedule();
  }

  function moveSelection(delta) {
    const agents = store.agents();
    if (!agents.length) return;
    const index = agents.findIndex((a) => a.id === ui.selected);
    const next = agents[(index + delta + agents.length) % agents.length] || agents[0];
    select(next.id);
  }

  function working() {
    return store.agents().some((a) => a.state === 'running' || a.state === 'starting' || a.checking);
  }

  function quit() {
    if (closed) return;
    closed = true;
    clearTimeout(renderTimer);
    clearInterval(spinner);
    unsubscribe();
    term.off?.('key', onKey);
    term.off?.('resize', onResize);
    term.stop();
    resolveDone();
  }

  function requestQuit() {
    if (working() && now() - ui.quitArmedAt > ARM_MS) {
      ui.quitArmedAt = now();
      notice('warn', t('confirm.quit'));
      return;
    }
    quit();
  }

  function openWaiting() {
    if (!store.waiting().length) return notice('info', t('notice.nothingPending'));
    ui.modal = { type: 'waiting', index: 0, input: new Editor() };
    schedule();
  }

  function closeModal() {
    ui.modal = null;
    schedule();
  }

  // Once per session at most, and only when the prompt says it is a good moment.
  function askForStar(moment) {
    if (!star || ui.modal || ui.starAsked) return;
    let due = false;
    try {
      due = star.due(moment);
    } catch {
      /* An unreadable prompt file never gets in the way. */
    }
    if (!due) return;
    ui.starAsked = true;
    ui.modal = { type: 'star', url: star.url };
    schedule();
  }

  function answerStar(choice) {
    try {
      star.answer(choice);
    } catch {
      /* Asked again another time. */
    }
    closeModal();
  }

  // ── composer ───────────────────────────────────────────────────────────

  async function submit() {
    const text = ui.editor.text;
    if (!text.trim()) {
      if (store.waiting().length) openWaiting();
      return;
    }
    ui.editor.submit();
    ui.completion = null;
    const target = selectedAgent();
    try {
      const result = await client.call('send', { text, to: target && target.state !== 'archived' ? target.name : null });
      if (result.dispatched.length) {
        if (!result.dispatched.some((d) => d.agentId === ui.selected)) select(result.dispatched[0].agentId);
        ui.scroll.set(ui.selected, 0);
        notice('info', t('notice.sent', { names: result.dispatched.map((d) => `@${d.agent}`).join(' ') }));
      }
      for (const s of result.skipped) notice('warn', t('notice.skipped', { target: s.target, reason: s.reason }));
    } catch (error) {
      // Give the text back so nothing typed is lost.
      if (!ui.editor.text) ui.editor.setText(text);
      notice('error', `${t('error.prefix')}: ${error.message}`);
    }
    schedule();
  }

  async function openCompletion() {
    const token = ui.editor.mentionToken();
    if (!token) return false;
    const items = await client.call('completions', { prefix: token.prefix }).catch(() => []);
    if (!items.length) {
      ui.completion = null;
      return false;
    }
    if (items.length === 1) {
      ui.editor.complete(items[0].name);
      ui.completion = null;
    } else {
      ui.completion = { all: items, items, index: 0 };
    }
    schedule();
    return true;
  }

  function refreshCompletion() {
    if (!ui.completion) return;
    const token = ui.editor.mentionToken();
    if (!token) {
      ui.completion = null;
      return;
    }
    const wanted = token.prefix.slice(1).toLowerCase();
    const items = ui.completion.all.filter((item) => item.name.toLowerCase().startsWith(wanted));
    ui.completion = items.length ? { ...ui.completion, items, index: Math.min(ui.completion.index, items.length - 1) } : null;
  }

  function composerKey(key) {
    const c = ui.completion;
    if (c) {
      if (key.name === 'up') return void ((c.index = (c.index - 1 + c.items.length) % c.items.length), schedule());
      if (key.name === 'down') return void ((c.index = (c.index + 1) % c.items.length), schedule());
      if (key.name === 'tab' || key.name === 'enter') {
        ui.editor.complete(c.items[c.index].name);
        ui.completion = null;
        return schedule();
      }
      if (key.name === 'escape') {
        ui.completion = null;
        return schedule();
      }
    }
    const e = ui.editor;
    switch (key.name) {
      case 'enter':
        return void submit();
      case 'newline':
        e.insert('\n');
        break;
      case 'text':
      case 'paste':
        e.insert(key.text);
        if (key.name === 'text' && key.text === '@' && e.mentionToken()) void openCompletion();
        break;
      case 'tab':
        void openCompletion();
        break;
      case 'escape':
        ui.focus = 'nav';
        break;
      case 'backspace':
        if (key.meta) e.deleteWordBack();
        else e.backspace();
        break;
      case 'delete':
        e.delete();
        break;
      case 'left':
        if (key.ctrl || key.meta) e.wordLeft();
        else e.left();
        break;
      case 'right':
        if (key.ctrl || key.meta) e.wordRight();
        else e.right();
        break;
      case 'home':
        e.home();
        break;
      case 'end':
        e.end();
        break;
      case 'up':
        e.up();
        break;
      case 'down':
        e.down();
        break;
      case 'pageup':
      case 'pagedown':
        return scroll(key.name);
      case 'a':
        if (key.ctrl) e.home();
        break;
      case 'e':
        if (key.ctrl) e.end();
        break;
      case 'k':
        if (key.ctrl) e.killToEnd();
        break;
      case 'u':
        if (key.ctrl) e.killToStart();
        break;
      case 'w':
        if (key.ctrl) e.deleteWordBack();
        break;
      case 'b':
        if (key.meta) e.wordLeft();
        break;
      case 'f':
        if (key.meta) e.wordRight();
        break;
      default:
        break;
    }
    refreshCompletion();
    schedule();
  }

  function scroll(name) {
    const agent = selectedAgent();
    if (!agent) return;
    const page = Math.max(3, (ui.layout?.bodyHeight || 20) - 4);
    const current = ui.scroll.get(agent.id) || 0;
    const max = ui.layout?.main ? Math.max(0, ui.layout.main.total - ui.layout.main.visible) : current + page;
    const next = { pageup: current + page, pagedown: current - page, home: max, end: 0 }[name];
    ui.scroll.set(agent.id, Math.max(0, Math.min(max, next)));
    schedule();
  }

  // ── navigation keys ────────────────────────────────────────────────────

  function navKey(key) {
    const agent = selectedAgent();
    const needAgent = () => {
      if (!agent) notice('info', t('notice.noAgent'));
      return agent;
    };
    if (key.name === 'text' && /^[1-9]$/.test(key.text)) {
      const target = store.agents()[Number(key.text) - 1];
      if (target) select(target.id);
      return;
    }
    const name = key.name === 'text' ? key.text : key.name;
    switch (name) {
      case 'i':
      case 'enter':
        ui.focus = 'composer';
        return schedule();
      case 'up':
      case 'k':
        return moveSelection(-1);
      case 'down':
      case 'j':
        return moveSelection(1);
      case 'pageup':
      case 'pagedown':
      case 'home':
      case 'end':
        return scroll(name);
      case 'a':
        return openWaiting();
      case 'd':
        if (needAgent()) openDiff(agent);
        return;
      case 'm':
        if (needAgent()) openMerge(agent);
        return;
      case 's':
        if (needAgent()) void act(client.call('stop', { agent: agent.id }), () => notice('info', t('notice.stopped', { name: agent.name })));
        return;
      case 'y':
        if (needAgent()) void act(client.call('retry', { agent: agent.id }));
        return;
      case 'u':
        if (needAgent()) void act(client.call('resumeQueue', { agent: agent.id }));
        return;
      case 'x':
        if (!needAgent()) return;
        if (ui.archiveArmed === agent.id) {
          ui.archiveArmed = null;
          void act(client.call('archive', { agent: agent.id }), () => {
            notice('info', t('notice.archived', { name: agent.name }));
            const next = store.agents()[0];
            select(next ? next.id : null);
          });
        } else {
          ui.archiveArmed = agent.id;
          notice('warn', `x → ${t('gui.archive')} @${agent.name}`);
          setTimeout(() => {
            if (ui.archiveArmed === agent.id) ui.archiveArmed = null;
          }, ARM_MS).unref?.();
        }
        return;
      case 'r':
        if (needAgent()) {
          ui.modal = { type: 'input', title: t('rename.prompt', { name: agent.name }), input: new Editor(), onSubmit: (text) => client.call('rename', { agent: agent.id, name: text.trim() }) };
          ui.modal.input.setText(agent.name);
          schedule();
        }
        return;
      case 'p':
        if (needAgent()) {
          ui.modal = {
            type: 'choice',
            title: t('mode.prompt', { name: agent.name }),
            index: Math.max(0, PERMISSION_MODES.indexOf(agent.mode)),
            choices: PERMISSION_MODES.map((mode) => ({ value: mode, label: t(`mode.${mode}`), description: t(`mode.describe.${mode}`) })),
            onChoose: (choice) => client.call('setMode', { agent: agent.id, mode: choice.value }),
          };
          schedule();
        }
        return;
      case 'n':
        ui.modal = { type: 'new', index: 0 };
        void client
          .call('providers', {})
          .then((list) => {
            store.state.providers = list;
            schedule();
          })
          .catch(() => {});
        return schedule();
      case 'g':
        ui.modal = { type: 'goals', index: 0 };
        return schedule();
      case 'b':
        ui.modal = { type: 'board', index: 0, scroll: 0 };
        return schedule();
      case '?':
        ui.modal = { type: 'help' };
        return schedule();
      case 'q':
        return requestQuit();
      case 'escape':
        ui.focus = 'composer';
        return schedule();
      default:
        return undefined;
    }
  }

  // ── modals ─────────────────────────────────────────────────────────────

  function openDiff(agent) {
    ui.modal = { type: 'diff', agentId: agent.id, agentName: agent.name, branch: agent.branch, scroll: 0, diff: null, width: 110 };
    schedule();
    void client
      .call('diff', { agent: agent.id })
      .then((diff) => {
        if (ui.modal?.type === 'diff' && ui.modal.agentId === agent.id) ui.modal.diff = diff;
      })
      .catch((error) => {
        if (ui.modal?.type === 'diff') ui.modal.error = error.message;
      })
      .finally(schedule);
  }

  function openMerge(agent) {
    ui.modal = {
      type: 'merge',
      agentId: agent.id,
      agentName: agent.name,
      target: store.state.project?.branch || agent.base || 'main',
      stage: 'menu',
      index: 0,
      options: [
        { key: 'review', label: 'merge.review' },
        { key: 'now', label: 'merge.now' },
        { key: 'cancel', label: 'merge.cancel' },
      ],
    };
    schedule();
  }

  async function doMerge(force) {
    const m = ui.modal;
    m.stage = 'merging';
    schedule();
    try {
      const result = await client.call('merge', { agent: m.agentId, force });
      closeModal();
      notice('success', t('merge.done', { branch: result.branch, target: result.target }));
      askForStar('merged');
    } catch (error) {
      if (ui.modal !== m) return;
      m.stage = 'error';
      m.error = { message: error.message, files: error.files };
      m.canForce = error.code === CODES.GATE_FAILED;
      schedule();
    }
  }

  async function startReview() {
    const m = ui.modal;
    m.stage = 'reviewing';
    schedule();
    try {
      const verdict = await client.call('review', { agent: m.agentId });
      if (ui.modal !== m) return;
      m.reviewer = verdict.reviewer;
      m.verdict = verdict;
      m.stage = 'verdict';
    } catch (error) {
      if (ui.modal !== m) return;
      m.stage = 'error';
      m.error = { message: error.message };
    }
    schedule();
  }

  function mergeKey(key) {
    const m = ui.modal;
    if (key.name === 'escape') return closeModal();
    if (m.stage === 'menu') {
      if (key.name === 'up') m.index = (m.index + 2) % 3;
      else if (key.name === 'down') m.index = (m.index + 1) % 3;
      else if (key.name === 'enter') {
        const choice = m.options[m.index].key;
        if (choice === 'review') void startReview();
        else if (choice === 'now') void doMerge(false);
        else closeModal();
      }
    } else if (m.stage === 'verdict' && key.name === 'enter') void doMerge(false);
    else if (m.stage === 'error' && m.canForce && (key.text === 'f' || key.name === 'f')) void doMerge(true);
    schedule();
  }

  function waitingKey(key) {
    const items = store.waiting();
    const m = ui.modal;
    if (!items.length || key.name === 'escape') return closeModal();
    m.index = Math.min(m.index, items.length - 1);
    const current = items[m.index];
    if (key.name === 'left') m.index = (m.index - 1 + items.length) % items.length;
    else if (key.name === 'right') m.index = (m.index + 1) % items.length;
    else if (current.type === 'approval') {
      const choice = { 1: 'allow_once', 2: 'allow_always', 3: 'deny' }[key.text];
      if (choice) void act(client.call('approve', { id: current.item.id, choice }));
    } else {
      const options = current.item.options || [];
      const n = key.name === 'text' && /^[1-9]$/.test(key.text) && !m.input.text ? Number(key.text) : 0;
      if (n && options[n - 1]) {
        void act(client.call('answerDecision', { id: current.item.id, answer: options[n - 1] }));
      } else if (key.name === 'enter') {
        const answer = m.input.text.trim();
        if (answer) {
          m.input.clear();
          void act(client.call('answerDecision', { id: current.item.id, answer }));
        }
      } else inputKey(m.input, key);
    }
    schedule();
  }

  function inputKey(input, key) {
    if (key.name === 'text' || key.name === 'paste') input.insert(key.text.replace(/\n/g, ' '));
    else if (key.name === 'backspace') input.backspace();
    else if (key.name === 'u' && key.ctrl) input.clear();
    else if (key.name === 'w' && key.ctrl) input.deleteWordBack();
  }

  function goalsKey(key) {
    const goals = store.goals();
    const m = ui.modal;
    const goal = goals[Math.min(m.index || 0, goals.length - 1)] || null;
    const name = key.name === 'text' ? key.text : key.name;
    if (name === 'escape') return closeModal();
    if (name === 'up') m.index = Math.max(0, (m.index || 0) - 1);
    else if (name === 'down') m.index = Math.min(goals.length - 1, (m.index || 0) + 1);
    else if (name === 'n') editGoal(null);
    else if (name === 'D') {
      ui.modal = { type: 'input', title: t('gui.draft'), description: t('goal.draftPrompt'), input: new Editor(), onSubmit: (text) => draftGoal(text) };
      ui.modal.input.setText('@');
    } else if (!goal) return schedule();
    else if (name === 'e') editGoal(goal);
    else if (name === 'a') {
      const problems = armProblems({ ...goal, approvedRevision: goal.revision });
      if (problems.length) {
        m.problems = problems;
        m.problemsFor = goal.id;
      } else void act(client.call('goalApprove', { id: goal.id }), () => notice('success', `${t('gui.approve')}: ${goal.title}`));
    } else if (name === 's') {
      const problems = armProblems(goal);
      if (problems.length) {
        m.problems = problems;
        m.problemsFor = goal.id;
      } else void act(client.call('goalStart', { id: goal.id }), () => closeModal());
    } else if (name === 'c') void act(client.call('goalCheck', { id: goal.id }), (gates) => notice(gates.every((g) => g.passed) ? 'success' : 'warn', `${t('gui.check')}: ${gates.map((g) => `@${g.agent} ${g.passed ? '✓' : '✗'}`).join(' ')}`));
    else if (name === 'p') void act(client.call('goalPause', { id: goal.id }));
    else if (name === 'x') {
      if (m.deleteArmed === goal.id) void act(client.call('goalDelete', { id: goal.id }), () => (m.deleteArmed = null));
      else {
        m.deleteArmed = goal.id;
        notice('warn', `x → ${t('gui.delete')}: ${goal.title}`);
      }
    } else if (/^[1-9]$/.test(name)) {
      const manual = goal.criteria.filter((c) => !c.check && !c.review)[Number(name) - 1];
      if (manual) void act(client.call('goalConfirm', { id: goal.id, criterion: manual.id, confirmed: !goal.confirmations?.[manual.id] }));
    }
    schedule();
  }

  function editGoal(goal) {
    const fields = goal
      ? { id: goal.id, title: goal.title, outcome: goal.outcome, criteria: goal.criteria, boundaries: goal.boundaries, questions: goal.questions, assignees: goal.assignees, maxIterations: goal.maxIterations }
      : { ...GOAL_TEMPLATE, assignees: [selectedAgent()?.name || GOAL_TEMPLATE.assignees[0]] };
    let edited;
    try {
      edited = (editJson || defaultEditJson)(fields);
    } catch (error) {
      return notice('error', `${t('error.prefix')}: ${error.message}`);
    } finally {
      screen.invalidate();
    }
    if (!edited) return schedule();
    void act(client.call('goalSave', { goal: goal ? { ...edited, id: goal.id } : edited }), () => notice('success', t('notice.goalSaved')));
  }

  function defaultEditJson(value) {
    // A private directory: a predictable name in a shared temp directory could be a planted link.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-harness-goal-'));
    const file = path.join(dir, 'goal.json');
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const editor = env.VISUAL || env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    term.suspend();
    try {
      // EDITOR may carry arguments ("code --wait"); the file name is ours.
      const result = spawnSync(`${editor} ${JSON.stringify(file)}`, { stdio: 'inherit', shell: true });
      if (result.status !== 0) throw new Error(`${editor} exited with ${result.status}`);
      const text = fs.readFileSync(file, 'utf8');
      if (text.trim() === JSON.stringify(value, null, 2)) return null;
      return JSON.parse(text);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      term.resume();
    }
  }

  function draftGoal(text) {
    const match = /^\s*@([a-z][a-z0-9_-]*)\s+([\s\S]+)$/i.exec(text);
    if (!match) throw new Error(t('goal.draftPrompt'));
    notice('info', `@${match[1]} …`);
    void act(client.call('goalDraft', { agent: match[1], description: match[2].trim() }), (goal) => {
      notice('success', `${t('notice.goalSaved')}: ${goal.title}`);
      ui.modal = { type: 'goals', index: 0 };
    });
    return null;
  }

  async function submitInput() {
    const m = ui.modal;
    try {
      const result = m.onSubmit(m.input.text);
      if (result?.then) await result;
      if (ui.modal === m) closeModal();
    } catch (error) {
      m.error = error.message;
      schedule();
    }
  }

  function modalKey(key) {
    const m = ui.modal;
    switch (m.type) {
      case 'waiting':
        return waitingKey(key);
      case 'merge':
        return mergeKey(key);
      case 'goals':
        return goalsKey(key);
      case 'diff':
        if (key.name === 'escape' || key.text === 'q') return closeModal();
        if (key.text === 'm') {
          const agent = store.state.agents.get(m.agentId);
          if (agent) openMerge(agent);
          return;
        }
        m.scroll = Math.max(0, (m.scroll || 0) + ({ up: -1, down: 1, pageup: -15, pagedown: 15 }[key.name] || 0));
        return schedule();
      case 'board':
        if (key.name === 'escape') return closeModal();
        if (key.name === 'up' || key.name === 'down') {
          m.index = Math.max(0, m.index + (key.name === 'up' ? -1 : 1));
          m.scroll = 0;
        }
        if (key.name === 'pageup') m.scroll = Math.max(0, (m.scroll || 0) - 10);
        if (key.name === 'pagedown') m.scroll = (m.scroll || 0) + 10;
        return schedule();
      case 'new': {
        const providers = store.state.providers;
        if (key.name === 'escape') return closeModal();
        if (key.name === 'up') m.index = Math.max(0, m.index - 1);
        if (key.name === 'down') m.index = Math.min(providers.length - 1, m.index + 1);
        if (key.name === 'enter') {
          const provider = providers[m.index];
          if (!provider) return undefined;
          if (!provider.available) {
            notice('warn', provider.fix || provider.reason);
            return schedule();
          }
          closeModal();
          void act(client.call('createAgent', { provider: provider.id }), (view) => {
            select(view.id);
            ui.focus = 'composer';
          });
        }
        return schedule();
      }
      case 'choice':
        if (key.name === 'escape') return closeModal();
        if (key.name === 'up') m.index = (m.index - 1 + m.choices.length) % m.choices.length;
        if (key.name === 'down') m.index = (m.index + 1) % m.choices.length;
        if (key.name === 'enter') {
          const choice = m.choices[m.index];
          closeModal();
          void act(m.onChoose(choice));
        }
        return schedule();
      case 'input':
        if (key.name === 'escape') return closeModal();
        if (key.name === 'enter') return void submitInput();
        inputKey(m.input, key);
        return schedule();
      case 'star':
        if (key.name === 'enter') {
          openUrl?.(m.url);
          answerStar('star');
          notice('success', t('star.thanks'));
        } else if (key.text === 'n') answerStar('never');
        else if (key.text === 'l' || key.name === 'escape') answerStar('later');
        return schedule();
      default:
        return closeModal();
    }
  }

  // ── events and keys ────────────────────────────────────────────────────

  function onKey(key) {
    if (closed) return;
    if (key.name === 'c' && key.ctrl) {
      if (ui.modal) return closeModal();
      if (ui.focus === 'composer' && ui.editor.text) {
        ui.editor.clear();
        ui.completion = null;
        return schedule();
      }
      return requestQuit();
    }
    if (key.name === 'l' && key.ctrl) {
      screen.invalidate();
      return schedule();
    }
    if (key.name === 'd' && key.ctrl && !ui.modal && !ui.editor.text) return requestQuit();
    if (ui.modal) return modalKey(key);
    if (ui.focus === 'composer') return composerKey(key);
    return navKey(key);
  }

  function onResize() {
    screen.invalidate();
    ui.wrapCache.clear();
    schedule();
  }

  function react(event) {
    switch (event.type) {
      case 'agent.updated':
        if (!ui.selected || !store.state.agents.has(ui.selected)) select(event.agent.id);
        break;
      case 'approval.requested':
      case 'decision.requested': {
        term.write('\x07');
        const who = event.approval?.agentName || event.decision?.agentName;
        if (!ui.modal && !ui.editor.text) openWaiting();
        else notice('warn', `@${who}: ${t(event.approval ? 'approval.title' : 'decision.title', { name: who })} — Esc, a`);
        break;
      }
      case 'approval.resolved':
      case 'decision.resolved':
        // Nothing left to answer: get out of the way.
        if (ui.modal?.type === 'waiting' && !store.waiting().length) closeModal();
        break;
      case 'notice':
        notice(event.level === 'success' ? 'success' : event.level, engineText(event, t));
        break;
      case 'review.started':
        // The review dialog names the reviewer as soon as the engine has chosen one.
        if (ui.modal?.type === 'merge' && ui.modal.agentId === event.agentId && ui.modal.stage === 'reviewing') ui.modal.reviewer = event.reviewer;
        break;
      case 'merge.result':
        if (!event.ok && !ui.modal) notice('error', event.error?.message || 'merge failed');
        break;
      default:
        break;
    }
  }

  const unsubscribe = client.subscribe((event) => {
    if (!store.applyEvent(event)) return;
    react(event);
    schedule();
  });
  // Spinners and elapsed times move while anything is working.
  const spinner = setInterval(() => {
    if (working() || ui.modal?.stage === 'reviewing' || ui.modal?.stage === 'merging') {
      frame++;
      schedule();
    }
  }, SPIN_MS);
  spinner.unref?.();

  const first = store.agents()[0];
  if (first) select(first.id);
  term.on('key', onKey);
  term.on('resize', onResize);
  term.start();
  try {
    star?.opened();
  } catch {
    /* Counting launches is best effort. */
  }
  render();
  if (store.waiting().length) openWaiting();
  else askForStar('launch');
  // In the background: a newer release is mentioned once and stays in the header.
  void update?.check().then((found) => {
    if (!found || closed) return;
    ui.update = found;
    notice('info', t('update.notice', found));
  });
  return done;
}
