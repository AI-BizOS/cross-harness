// Troupe web UI. Same engine client and store as the terminal UI; everything an
// agent wrote is inserted as text (never as HTML).
import { createStore, lastGate } from '/store.js';
import { engineText, translate } from '/i18n.js';

const lang = document.documentElement.dataset.lang === 'zh' ? 'zh' : 'en';
const t = (key, params) => translate(lang, key, params);
const store = createStore();
const MODES = ['plan', 'ask', 'workspace', 'full'];
const COLORS = ['#2f8fd8', '#b052c9', '#d08a12', '#2e9d58', '#3b6fe0', '#18a3a3', '#c94f7c', '#6f8f1e'];
const $ = (id) => document.getElementById(id);

const ui = {
  selected: null,
  dialog: null,
  completion: null,
  connected: false,
  lastEntryCount: new Map(),
};

// ── token and API ───────────────────────────────────────────────────────

function readToken() {
  const match = /token=([0-9a-f]+)/.exec(location.hash);
  if (match) {
    sessionStorage.setItem('troupe-token', match[1]);
    history.replaceState(null, '', location.pathname);
    return match[1];
  }
  return sessionStorage.getItem('troupe-token') || '';
}
const token = readToken();

async function api(method, params = {}) {
  const response = await fetch('/api/call', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const body = await response.json().catch(() => ({ ok: false, error: { message: response.statusText } }));
  if (!body.ok) throw Object.assign(new Error(body.error?.message || 'Request failed'), { code: body.error?.code });
  return body.result;
}

// The GitHub star prompt is kept by the local server (src/star.js), not by the engine.
async function starRequest(method, value) {
  const post = method === 'POST';
  const response = await fetch(post ? '/api/star' : `/api/star?moment=${encodeURIComponent(value)}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(post ? { 'Content-Type': 'application/json' } : {}) },
    ...(post ? { body: JSON.stringify({ answer: value }) } : {}),
  });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message || 'Request failed');
  return body.result;
}

// The local server checks for a newer Troupe at most once a day (src/update.js).
async function checkUpdate() {
  if (ui.updateChecked) return;
  ui.updateChecked = true;
  const response = await fetch('/api/update', { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  const body = await response?.json().catch(() => null);
  if (!body?.ok || !body.result) return;
  ui.update = body.result;
  toast(t('update.notice', ui.update), 'info');
  invalidate('top');
}

// Once per page at most, and only when the server says it is a good moment.
async function askForStar(moment) {
  if (ui.starAsked) return;
  const result = await starRequest('GET', moment).catch(() => null);
  if (!result?.due || ui.dialog || ui.starAsked) return;
  ui.starAsked = true;
  openDialog({ type: 'star', url: result.url });
}

async function attempt(promise, success) {
  try {
    const result = await promise;
    if (success) toast(typeof success === 'function' ? success(result) : success, 'success');
    return result;
  } catch (error) {
    toast(`${t('error.prefix')}: ${error.message}`, 'error');
    return null;
  }
}

// ── event stream ────────────────────────────────────────────────────────

async function connect() {
  let delay = 500;
  for (;;) {
    let streamed = false;
    try {
      const response = await fetch('/api/events', { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      setConnected(true);
      streamed = true;
      delay = 500;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          handleBlock(block);
        }
      }
    } catch {
      streamed = false;
    }
    // A stream that ended normally is resumed at once; only failed attempts show the banner.
    if (!streamed) setConnected(false);
    await new Promise((resolve) => setTimeout(resolve, streamed ? 200 : delay));
    if (!streamed) delay = Math.min(delay * 2, 8000);
  }
}

function handleBlock(block) {
  let type = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!data) return;
  const payload = JSON.parse(data);
  if (type === 'snapshot') {
    store.applySnapshot(payload);
    if (!ui.selected || !store.state.agents.has(ui.selected)) ui.selected = store.agents()[0]?.id || null;
    if (ui.selected) loadTranscript(ui.selected);
    updatePlaceholder();
    invalidate('all');
    void askForStar('launch');
    void checkUpdate();
    return;
  }
  if (type === 'failure') return toast(payload.error?.message || 'failure', 'error');
  if (store.applyEvent(payload)) react(payload);
}

function setConnected(value) {
  if (ui.connected === value) return;
  ui.connected = value;
  const banner = $('banner');
  banner.hidden = value;
  banner.textContent = value ? '' : t('gui.disconnected');
  invalidate('top');
}

function react(event) {
  switch (event.type) {
    case 'agent.updated':
      if (!ui.selected) {
        ui.selected = event.agent.id;
        loadTranscript(ui.selected);
        updatePlaceholder();
        invalidate('head', 'entries');
      }
      invalidate('side', 'top');
      if (event.agent.id === ui.selected) invalidate('head', 'live');
      break;
    case 'agent.message':
      if (event.agentId === ui.selected) invalidate('entries', 'live');
      break;
    case 'agent.text':
    case 'agent.activity':
    case 'agent.plan':
      if (event.agentId === ui.selected) invalidate('live');
      invalidate('side');
      break;
    case 'approval.requested':
    case 'decision.requested':
      invalidate('waiting', 'side', 'top');
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        const who = event.approval?.agentName || event.decision?.agentName;
        new Notification(`Troupe · @${who}`, { body: event.approval ? t('approval.title') : t('decision.title', { name: who }) });
      }
      break;
    case 'approval.resolved':
    case 'decision.resolved':
      invalidate('waiting', 'side', 'top');
      break;
    case 'board.updated':
      invalidate('side');
      if (ui.dialog?.type === 'board') invalidate('dialog');
      break;
    case 'goal.updated':
    case 'gate.result':
      invalidate('side', 'top');
      if (ui.dialog?.type === 'goals') invalidate('dialog');
      break;
    case 'notice':
      toast(engineText(event, t), event.level);
      break;
    case 'review.started':
      // The review dialog names the reviewer as soon as the engine has chosen one.
      if (ui.dialog?.type === 'merge' && ui.dialog.agentId === event.agentId && ui.dialog.stage === 'reviewing') {
        ui.dialog.reviewer = event.reviewer;
        renderDialog();
      }
      break;
    case 'project.updated':
      invalidate('top');
      if (ui.dialog?.type === 'new') invalidate('dialog');
      break;
    default:
      break;
  }
}

function loadTranscript(agentId) {
  if (!agentId || store.state.loaded.has(agentId)) return;
  store.state.loaded.add(agentId);
  api('transcript', { agent: agentId, limit: 400 })
    .then((result) => {
      store.setTranscript(agentId, result.entries);
      if (agentId === ui.selected) invalidate('entries');
    })
    .catch(() => store.state.loaded.delete(agentId));
}

// ── DOM helpers ─────────────────────────────────────────────────────────

/** h('div', {class:'x', onclick: fn, title: 'y'}, child, 'text', [more]) */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style') applyStyle(el, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

// The page's CSP forbids style attributes; the CSSOM is allowed.
function applyStyle(el, declarations) {
  for (const declaration of String(declarations).split(';')) {
    const index = declaration.indexOf(':');
    if (index > 0) el.style.setProperty(declaration.slice(0, index).trim(), declaration.slice(index + 1).trim());
  }
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function replace(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

function colorFor(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function count(n) {
  return n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`;
}

/** Agent text: paragraphs, fenced code blocks and `inline code`, all as text nodes. */
function richText(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  let paragraph = [];
  let code = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = h('p');
    const joined = paragraph.join('\n');
    joined.split(/(`[^`\n]+`)/).forEach((part) => {
      if (/^`[^`\n]+`$/.test(part)) p.append(h('code', { text: part.slice(1, -1) }));
      else if (part) p.append(document.createTextNode(part));
    });
    out.push(p);
    paragraph = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (code === null) {
        flushParagraph();
        code = [];
      } else {
        out.push(h('pre', {}, h('code', { text: code.join('\n') })));
        code = null;
      }
      continue;
    }
    if (code !== null) code.push(line);
    else if (!line.trim()) flushParagraph();
    else paragraph.push(line);
  }
  if (code !== null) out.push(h('pre', {}, h('code', { text: code.join('\n') })));
  flushParagraph();
  return out;
}

// ── rendering ───────────────────────────────────────────────────────────

const dirty = new Set();
let frame = 0;
function invalidate(...parts) {
  for (const part of parts) dirty.add(part);
  if (!frame) frame = requestAnimationFrame(flush);
}

function flush() {
  frame = 0;
  const all = dirty.has('all');
  if (all || dirty.has('top')) renderTop();
  if (all || dirty.has('side')) renderSide();
  if (all || dirty.has('waiting')) renderWaiting();
  if (all || dirty.has('head')) renderHead();
  if (all || dirty.has('entries')) renderEntries();
  if (all || dirty.has('live')) renderLive();
  if (dirty.has('dialog')) renderDialog();
  dirty.clear();
}

function selectedAgent() {
  return ui.selected ? store.state.agents.get(ui.selected) || null : null;
}

function select(agentId) {
  ui.selected = agentId;
  $('shell').classList.remove('side-open');
  loadTranscript(agentId);
  ui.lastEntryCount.delete(agentId);
  invalidate('side', 'head', 'entries', 'live');
  updatePlaceholder();
}

function stateText(agent) {
  if (agent.checking) return { text: t('state.checking'), cls: 'warn' };
  if (agent.needsYou) return { text: `! ${agent.needsYou}`, cls: 'warn' };
  if (agent.waitingOn) return { text: t('state.waitingOn', { name: agent.waitingOn }), cls: 'accent' };
  if (agent.waitingForSlot) return { text: t('state.slot'), cls: '' };
  const cls = { running: 'accent', starting: 'accent', idle: 'ok', failed: 'bad', stopped: 'warn' }[agent.state] || '';
  return { text: t(`state.${agent.state}`), cls };
}

function renderTop() {
  const project = store.state.project;
  const counts = store.counts();
  const goal = store.activeGoal();
  replace(
    $('topbar'),
    h('button', { class: 'ghost menu-toggle', 'aria-label': t('gui.agents'), onclick: () => $('shell').classList.toggle('side-open') }, '☰'),
    h('span', { class: 'brand' }, 'Troupe'),
    h('span', { class: 'project' }, project ? `${project.name}${project.branch ? ` (${project.branch})` : ''}` : ''),
    h('span', { class: 'pill hide-narrow' }, t('header.agents', { n: counts.agents })),
    counts.working ? h('span', { class: 'pill accent hide-narrow' }, t('header.working', { n: counts.working })) : null,
    counts.waiting ? h('span', { class: 'pill warn' }, t('header.needsYou', { n: counts.waiting })) : null,
    goal ? h('button', { class: 'pill hide-narrow', onclick: () => openDialog({ type: 'goals', goalId: goal.id }) }, `◆ ${goal.title} · ${t(`goal.status.${goal.status}`)}`) : null,
    h('span', { class: 'spacer' }),
    ui.update ? h('button', { class: 'pill accent', title: t('update.notice', ui.update), onclick: () => toast(t('update.notice', ui.update), 'info') }, t('update.badge', ui.update)) : null,
    h('button', { onclick: () => openDialog({ type: 'goals' }) }, t('gui.goals')),
    h('button', { class: 'hide-narrow', onclick: () => openDialog({ type: 'board' }) }, t('gui.board')),
    h('button', { class: 'primary', onclick: () => openDialog({ type: 'new' }) }, `+ ${t('gui.newAgent')}`),
    h('span', { class: `dot ${ui.connected ? 'live' : 'down'}`, title: ui.connected ? 'connected' : 'disconnected' }),
  );
}

function renderSide() {
  const agents = store.agents();
  const waiting = store.waiting();
  const goals = store.goals();
  const items = agents.map((agent) => {
    const state = stateText(agent);
    const busy = agent.state === 'running' || agent.state === 'starting' || agent.checking;
    const sub = agent.activity?.title || agent.progress || (agent.queue ? t(agent.queuePaused ? 'state.paused' : 'state.queued', { n: agent.queue }) : '') || agent.error?.message || agent.branch || t('agent.shared');
    return h(
      'button',
      { class: `agent-item${agent.id === ui.selected ? ' selected' : ''}`, onclick: () => select(agent.id), title: `${agent.providerName} · ${t(`mode.${agent.mode}`)}` },
      h('span', { class: `avatar${busy ? ' busy' : ''}`, style: `background:${colorFor(agent.name)}` }),
      h('span', { class: 'name' }, `@${agent.name}`),
      h('span', { class: `pill ${state.cls}` }, state.text),
      h('span', { class: 'sub' }, sub),
    );
  });
  replace(
    $('sidebar'),
    h('div', { class: 'side-title' }, h('span', {}, t('gui.agents')), h('button', { class: 'ghost', onclick: () => openDialog({ type: 'new' }), title: t('gui.newAgent') }, '+')),
    items.length ? items : h('p', { class: 'muted', style: 'padding:0 8px' }, t('empty.noAgents')),
    waiting.length ? [h('div', { class: 'side-title' }, `${t('gui.approvals')} (${waiting.length})`), waiting.slice(0, 5).map((w) => h('div', { class: 'sub muted', style: 'padding:2px 8px;font-size:12px' }, `@${w.item.agentName}: ${w.type === 'approval' ? w.item.command || w.item.title : w.item.question}`))] : null,
    h('div', { class: 'side-title' }, t('gui.goals')),
    goals.slice(0, 5).map((goal) => h('button', { class: 'side-link', onclick: () => openDialog({ type: 'goals', goalId: goal.id }) }, h('span', {}, `◆ ${goal.title || '…'}`), h('span', { class: 'muted' }, t(`goal.status.${goal.status}`)))),
    h('button', { class: 'side-link', onclick: () => openDialog({ type: 'goals' }) }, h('span', { class: 'muted' }, `+ ${t('gui.newGoal')}`)),
    h('div', { class: 'side-title' }, t('board.title')),
    h('button', { class: 'side-link', onclick: () => openDialog({ type: 'board' }) }, h('span', {}, t('gui.board')), h('span', { class: 'muted' }, String(store.state.board.entries?.length || 0))),
  );
}

function renderWaiting() {
  const waiting = store.waiting();
  replace(
    $('waiting'),
    waiting.map((w) => (w.type === 'approval' ? approvalCard(w.item) : decisionCard(w.item))),
  );
}

function approvalCard(a) {
  return h(
    'div',
    { class: 'card attention' },
    h('div', { class: 'card-head' }, h('span', { class: 'avatar', style: `background:${colorFor(a.agentName)}` }), h('b', {}, `@${a.agentName}`), h('span', { class: 'pill warn' }, t(`approval.kind.${a.kind}`) || a.kind), h('span', { class: 'muted' }, t('approval.title'))),
    h('pre', {}, h('code', { text: a.command || a.title })),
    a.detail && a.detail !== a.command && a.detail !== a.title ? h('details', {}, h('summary', { class: 'muted' }, '…'), h('pre', {}, h('code', { text: a.detail }))) : null,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'primary', onclick: () => attempt(api('approve', { id: a.id, choice: 'allow_once' })) }, t('approval.allowOnce')),
      h('button', { class: 'ok', onclick: () => attempt(api('approve', { id: a.id, choice: 'allow_always' })) }, t('approval.allowAlways', { name: a.agentName })),
      h('button', { class: 'danger', onclick: () => attempt(api('approve', { id: a.id, choice: 'deny' })) }, t('approval.deny')),
    ),
  );
}

function decisionCard(d) {
  const input = h('input', { type: 'text', placeholder: t('decision.type') });
  const answer = (value) => value.trim() && attempt(api('answerDecision', { id: d.id, answer: value.trim() }));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) answer(input.value);
  });
  return h(
    'div',
    { class: 'card attention' },
    h('div', { class: 'card-head' }, h('span', { class: 'avatar', style: `background:${colorFor(d.agentName)}` }), h('b', {}, t('decision.title', { name: d.agentName }))),
    h('div', { class: 'body' }, richText(d.question)),
    d.options?.length ? h('div', { class: 'actions' }, d.options.map((option) => h('button', { onclick: () => answer(option) }, option))) : null,
    h('div', { class: 'answer-row' }, input, h('button', { class: 'primary', onclick: () => answer(input.value) }, t('decision.send'))),
  );
}

function renderHead() {
  const agent = selectedAgent();
  if (!agent) return replace($('agent-head'));
  const state = stateText(agent);
  const tokens = (agent.usage?.input_tokens || 0) + (agent.usage?.output_tokens || 0);
  const busy = agent.state === 'running' || agent.state === 'starting';
  const mode = h('select', { 'aria-label': t('gui.mode'), onchange: (event) => attempt(api('setMode', { agent: agent.id, mode: event.target.value })) }, MODES.map((m) => h('option', { value: m, selected: m === agent.mode, title: t(`mode.describe.${m}`) }, t(`mode.${m}`))));
  replace(
    $('agent-head'),
    h('span', { class: 'avatar', style: `background:${colorFor(agent.name)}` }),
    h('span', { class: 'title' }, `@${agent.name}`),
    h('span', { class: 'meta' }, `${agent.providerName}${agent.branch ? ` · ${agent.branch}` : ` · ${t('agent.shared')}`}${tokens ? ` · ${count(tokens)} tok` : ''}`),
    agent.verified ? null : h('span', { class: 'pill warn', title: t('agent.untested') }, t('provider.untested')),
    h('span', { class: `pill ${state.cls}` }, state.text),
    h('span', { class: 'grow' }),
    h(
      'span',
      { class: 'tools' },
      mode,
      busy ? h('button', { class: 'danger', onclick: () => attempt(api('stop', { agent: agent.id }), t('notice.stopped', { name: agent.name })) }, t('gui.stop')) : null,
      agent.queuePaused && agent.queue ? h('button', { onclick: () => attempt(api('resumeQueue', { agent: agent.id })) }, t('gui.resume')) : null,
      h('button', { onclick: () => openDialog({ type: 'diff', agentId: agent.id }) }, t('gui.diff')),
      agent.branch ? h('button', { onclick: () => openDialog({ type: 'merge', agentId: agent.id, stage: 'menu' }) }, t('gui.merge')) : null,
      h('button', { onclick: () => attempt(api('retry', { agent: agent.id })) }, t('gui.retry')),
      h('button', { onclick: () => openDialog({ type: 'rename', agentId: agent.id }) }, t('gui.rename')),
      h('button', { class: 'danger', onclick: () => confirm(`${t('gui.archive')} @${agent.name}?`) && attempt(api('archive', { agent: agent.id }), t('notice.archived', { name: agent.name })) }, t('gui.archive')),
    ),
  );
}

const ROLE_LABEL = {
  user: () => t('role.you'),
  question: (e) => t('role.asks', { name: e.from?.name || '?' }),
  feedback: () => t('role.feedback'),
  review: () => t('role.review'),
  compare: () => t('role.compare'),
  draft: () => t('role.draft'),
};

function steps(activities) {
  if (!activities?.length) return null;
  const list = activities.filter((a) => a.kind !== 'thinking');
  if (!list.length) return null;
  return h(
    'details',
    { class: 'steps' },
    h('summary', {}, `${list.length} ${lang === 'zh' ? '个步骤' : list.length === 1 ? 'step' : 'steps'}`),
    list.map((a) => stepRow(a)),
  );
}

function stepRow(a) {
  const mark = a.status === 'running' ? h('span', { class: 'run' }, '●') : a.status === 'failed' ? h('span', { class: 'bad' }, '✗') : h('span', { class: 'ok' }, '✓');
  return h('div', { class: 'step', title: a.detail || a.title }, mark, h('span', { class: 'mono' }, a.title), a.detail && a.detail !== a.title ? h('span', { class: 'muted mono' }, a.detail) : null);
}

function entryNode(entry, agent) {
  if (entry.params) entry = { ...entry, text: engineText(entry, t) };
  if (entry.role === 'system') return h('div', { class: 'entry system' }, `· ${entry.text}`, steps(entry.activities));
  if (entry.role === 'error') return h('div', { class: 'entry error' }, `✖ ${entry.text}${entry.code ? ` (${entry.code})` : ''}`, steps(entry.activities));
  if (entry.role === 'gate') {
    const gate = entry.gate || {};
    return h(
      'div',
      { class: `entry gate${gate.passed ? '' : ' failed'}` },
      h('div', { class: 'who' }, `◆ ${t('role.gate')}: ${entry.text}`),
      h('div', { class: 'criteria' }, (gate.criteria || []).map((c) => h('div', { class: 'criterion' }, h('span', { class: c.passed ? 'ok' : 'bad' }, c.passed ? '✓' : '✗'), h('span', {}, h('b', {}, c.id), ' ', h('span', { class: 'summary' }, c.summary))))),
    );
  }
  const who = entry.role === 'assistant' ? h('span', { style: `color:${colorFor(agent.name)}` }, `@${agent.name}`) : h('span', {}, (ROLE_LABEL[entry.role] || ROLE_LABEL.user)(entry));
  const when = [entry.durationMs ? duration(entry.durationMs) : null, entry.at ? new Date(entry.at).toLocaleTimeString() : null].filter(Boolean).join(' · ');
  return h('div', { class: `entry ${entry.role}` }, h('div', { class: 'who' }, who, h('span', { class: 'when' }, when)), h('div', { class: 'body' }, richText(entry.text)), steps(entry.activities));
}

function nearBottom() {
  const s = $('scroller');
  return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
}

function renderEntries() {
  const agent = selectedAgent();
  const pinned = nearBottom();
  if (!agent) {
    replace($('entries'), welcome());
    return;
  }
  const entries = store.state.transcripts.get(agent.id) || [];
  replace($('entries'), entries.length ? entries.map((entry) => entryNode(entry, agent)) : h('p', { class: 'muted' }, store.state.loaded.has(agent.id) ? t('empty.transcript') : '…'));
  if (pinned || ui.lastEntryCount.get(agent.id) === undefined) $('scroller').scrollTop = $('scroller').scrollHeight;
  ui.lastEntryCount.set(agent.id, entries.length);
}

function renderLive() {
  const agent = selectedAgent();
  const pinned = nearBottom();
  if (!agent || !(agent.state === 'running' || agent.state === 'starting' || agent.checking)) return replace($('live'));
  const live = store.state.live.get(agent.id);
  const plan = live?.plan?.length ? live.plan : agent.plan || [];
  const activities = live ? [...live.activities.values()].filter((a) => a.kind !== 'thinking').slice(-8) : [];
  replace(
    $('live'),
    h('div', { class: 'status' }, `● @${agent.name} ${agent.checking ? t('state.checking') : t('agent.liveTurn', { time: agent.turnStartedAt ? duration(Date.now() - agent.turnStartedAt) : '' })}`),
    agent.waitingOn ? h('div', { class: 'muted' }, `⧗ ${t('state.waitingOn', { name: agent.waitingOn })}`) : null,
    plan.length ? h('ul', { class: 'plan' }, plan.map((p) => h('li', { class: p.status }, `${p.status === 'completed' ? '☑' : p.status === 'in_progress' ? '◐' : '☐'} ${p.content}`))) : null,
    activities.map((a) => stepRow(a)),
    live?.text || agent.text ? h('div', { class: 'body' }, richText(live?.text || agent.text)) : null,
  );
  if (pinned) $('scroller').scrollTop = $('scroller').scrollHeight;
}

function welcome() {
  const providers = store.state.providers;
  const examples = ['@codex @claude review src/', '@codex fix the failing test\n@kimi add edge-case tests', '@all @compare:claude which approach is simpler?'];
  return h(
    'div',
    { class: 'welcome' },
    h('h1', {}, 'Troupe'),
    h('p', { class: 'muted' }, t('app.tagline')),
    h('p', {}, t('empty.noAgents')),
    h(
      'div',
      { class: 'providers' },
      providers.map((p) =>
        h(
          'button',
          { class: `provider${p.available ? '' : ' unavailable'}`, onclick: () => insertMention(p.id), title: p.available ? '' : p.fix || p.reason },
          h('div', { class: 'pname' }, `@${p.id}`),
          h('div', { class: 'pmeta' }, `${p.name}${p.version ? ` ${p.version}` : ''}${p.available ? (p.verified ? '' : ` · ${t('provider.untested')}`) : ` · ${t('new.unavailable')}`}`),
        ),
      ),
    ),
    h('div', { class: 'examples' }, examples.map((example) => h('button', { onclick: () => setComposer(example) }, example))),
  );
}

// ── composer ────────────────────────────────────────────────────────────

const input = $('input');

function setComposer(text) {
  input.value = text;
  input.focus();
  autosize();
}

function insertMention(name) {
  const value = input.value;
  setComposer(value && !value.endsWith(' ') && !value.endsWith('\n') ? `${value} @${name} ` : `${value}@${name} `);
}

function updatePlaceholder() {
  const agent = selectedAgent();
  input.placeholder = agent ? t('composer.placeholderTo', { name: agent.name }) : t('composer.placeholder');
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight + 2, window.innerHeight * 0.4)}px`;
}

function mentionToken() {
  const before = input.value.slice(0, input.selectionStart);
  const lineStart = before.lastIndexOf('\n') + 1;
  const match = /^\s*(?:@[A-Za-z0-9][A-Za-z0-9_.-]*\+?(?::[A-Za-z0-9_.-]+)?\s+)*@([A-Za-z0-9_.-]*)$/.exec(before.slice(lineStart));
  return match ? { prefix: `@${match[1]}`, start: input.selectionStart - match[1].length - 1, end: input.selectionStart } : null;
}

async function updateCompletion() {
  const token = mentionToken();
  if (!token) return closeCompletion();
  const items = await api('completions', { prefix: token.prefix }).catch(() => []);
  if (!items.length || mentionToken()?.prefix !== token.prefix) return closeCompletion();
  ui.completion = { items: items.slice(0, 8), index: 0, token };
  renderCompletion();
}

function renderCompletion() {
  const box = $('completion');
  const c = ui.completion;
  if (!c) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  replace(
    box,
    c.items.map((item, i) =>
      h(
        'button',
        { type: 'button', class: i === c.index ? 'active' : '', role: 'option', onmousedown: (event) => (event.preventDefault(), applyCompletion(i)) },
        h('b', { style: item.kind === 'special' ? '' : `color:${colorFor(item.name)}` }, `@${item.name}`),
        h('span', { class: 'detail' }, item.detail || ''),
      ),
    ),
  );
}

function closeCompletion() {
  ui.completion = null;
  renderCompletion();
}

function applyCompletion(index) {
  const c = ui.completion;
  if (!c) return;
  const token = mentionToken() || c.token;
  const name = c.items[index].name;
  const after = input.value.slice(token.end).replace(/^[A-Za-z0-9_.-]*/, '');
  input.value = `${input.value.slice(0, token.start)}@${name}${after.startsWith(' ') ? '' : ' '}${after}`;
  const caret = token.start + name.length + 2;
  input.setSelectionRange(caret, caret);
  closeCompletion();
  input.focus();
}

async function send() {
  const text = input.value;
  if (!text.trim()) return;
  input.value = '';
  autosize();
  closeCompletion();
  const agent = selectedAgent();
  try {
    const result = await api('send', { text, to: agent && agent.state !== 'archived' ? agent.name : null });
    if (result.dispatched.length && !result.dispatched.some((d) => d.agentId === ui.selected)) select(result.dispatched[0].agentId);
    for (const s of result.skipped) toast(t('notice.skipped', { target: s.target, reason: s.reason }), 'warn');
  } catch (error) {
    if (!input.value) input.value = text;
    autosize();
    toast(`${t('error.prefix')}: ${error.message}`, 'error');
  }
}

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  void send();
});
input.addEventListener('keydown', (event) => {
  const c = ui.completion;
  if (c && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'].includes(event.key)) {
    event.preventDefault();
    if (event.key === 'ArrowDown') c.index = (c.index + 1) % c.items.length;
    else if (event.key === 'ArrowUp') c.index = (c.index - 1 + c.items.length) % c.items.length;
    else if (event.key === 'Escape') return closeCompletion();
    else return applyCompletion(c.index);
    return renderCompletion();
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
});
input.addEventListener('input', () => {
  autosize();
  if (mentionToken()) void updateCompletion();
  else if (ui.completion) closeCompletion();
});
input.addEventListener('blur', () => setTimeout(closeCompletion, 150));

// ── dialogs ─────────────────────────────────────────────────────────────

const dialog = $('dialog');
dialog.addEventListener('close', () => {
  // Escape closes the dialog without an answer: the star prompt counts that as "later".
  if (ui.dialog?.type === 'star' && !ui.dialog.answered) void starRequest('POST', 'later').catch(() => {});
  ui.dialog = null;
});

function openDialog(state) {
  ui.dialog = state;
  dialog.classList.toggle('small', state.type === 'star');
  renderDialog();
  if (!dialog.open) dialog.showModal();
  if (state.type === 'diff') loadDiff(state);
  if (state.type === 'merge' && !state.diff) loadDiff(state);
  if (state.type === 'new') api('providers', {}).then((list) => ((store.state.providers = list), renderDialog())).catch(() => {});
}

function closeDialog() {
  if (ui.dialog?.type === 'star' && !ui.dialog.answered) {
    ui.dialog.answered = true;
    void starRequest('POST', 'later').catch(() => {});
  }
  if (dialog.open) dialog.close();
  ui.dialog = null;
}

function dialogFrame(title, body, extra = null) {
  return [h('div', { class: 'dialog-head' }, h('h2', {}, title), extra, h('button', { class: 'ghost', onclick: closeDialog, 'aria-label': t('gui.close') }, '✕')), h('div', { class: 'dialog-body' }, body)];
}

function renderDialog() {
  const d = ui.dialog;
  if (!d) return;
  const views = { diff: diffDialog, merge: mergeDialog, goals: goalsDialog, board: boardDialog, new: newDialog, rename: renameDialog, star: starDialog };
  replace(dialog, ...(views[d.type] || (() => []))(d));
}

async function loadDiff(state) {
  try {
    state.diff = await api('diff', { agent: state.agentId });
  } catch (error) {
    state.error = error.message;
  }
  if (ui.dialog === state) renderDialog();
}

function diffView(diff) {
  if (!diff) return h('p', { class: 'muted' }, '…');
  const facts = [diff.isolated ? t('diff.branch', { branch: store.state.agents.get(ui.dialog?.agentId)?.branch || '', base: diff.base }) : t('diff.shared'), diff.commits ? t('diff.commits', { n: diff.commits }) : null, diff.uncommitted ? t('diff.uncommitted') : null].filter(Boolean);
  const patch = h('pre', { class: 'patch' });
  for (const line of String(diff.patch || '').split('\n')) {
    const cls = /^(\+\+\+|---|diff |index )/.test(line) ? 'head' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
    patch.append(h('span', { class: cls }, `${line}\n`));
  }
  return [
    h('p', { class: 'muted' }, facts.join(' · ')),
    diff.files?.length
      ? h(
          'div',
          { class: 'files' },
          diff.files.map((f) => h('div', { class: f.status }, `${f.status === 'added' ? '+' : f.status === 'deleted' ? '-' : '~'} ${f.path}  ${f.added ?? '?'}+ ${f.removed ?? '?'}-`)),
        )
      : null,
    diff.patch ? patch : h('p', { class: 'muted' }, t('diff.none')),
    diff.truncated ? h('p', { class: 'muted' }, t('diff.truncated')) : null,
  ];
}

function diffDialog(d) {
  const agent = store.state.agents.get(d.agentId);
  return dialogFrame(t('diff.title', { name: agent?.name || '' }), d.error ? h('p', { class: 'muted' }, d.error) : diffView(d.diff), agent?.branch ? h('button', { onclick: () => openDialog({ type: 'merge', agentId: d.agentId, stage: 'menu', diff: d.diff }) }, t('gui.merge')) : null);
}

function mergeDialog(d) {
  const agent = store.state.agents.get(d.agentId);
  const target = store.state.project?.branch || 'main';
  const body = [];
  if (d.stage === 'menu') {
    body.push(
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'primary', onclick: () => review(d) }, t('merge.review')),
        h('button', { onclick: () => merge(d, false) }, t('merge.now')),
        h('button', { class: 'ghost', onclick: closeDialog }, t('merge.cancel')),
      ),
    );
  } else if (d.stage === 'reviewing') {
    body.push(h('p', {}, t('merge.reviewing', { reviewer: d.reviewer || '…' })));
  } else if (d.stage === 'verdict') {
    const v = d.verdict;
    body.push(h('div', { class: `verdict ${v.passed ? 'pass' : 'fail'}` }, h('b', {}, t('merge.verdict', { reviewer: v.reviewer, verdict: v.passed ? 'PASS' : 'FAIL' })), ' — ', v.summary));
    if (v.answer) body.push(h('details', {}, h('summary', {}, `@${v.reviewer}`), h('div', { class: 'body' }, richText(v.answer))));
    body.push(h('div', { class: 'dialog-actions' }, h('button', { class: 'primary', onclick: () => merge(d, false) }, t('merge.confirm')), h('button', { class: 'ghost', onclick: closeDialog }, t('merge.cancel'))));
  } else if (d.stage === 'merging') {
    body.push(h('p', {}, 'git merge…'));
  } else if (d.stage === 'error') {
    body.push(h('div', { class: 'verdict fail' }, d.error.message, d.error.files?.length ? h('ul', {}, d.error.files.map((f) => h('li', { class: 'mono' }, f))) : null));
    body.push(h('div', { class: 'dialog-actions' }, d.canForce ? h('button', { class: 'danger', onclick: () => merge(d, true) }, t('merge.force')) : null, h('button', { onclick: closeDialog }, t('gui.close'))));
  }
  body.push(h('hr', { style: 'border:none;border-top:1px solid var(--line);margin:14px 0' }), diffView(d.diff));
  return dialogFrame(t('merge.title', { name: agent?.name || '', target }), body);
}

async function review(d) {
  d.stage = 'reviewing';
  renderDialog();
  try {
    d.verdict = await api('review', { agent: d.agentId });
    d.reviewer = d.verdict.reviewer;
    d.stage = 'verdict';
  } catch (error) {
    d.stage = 'error';
    d.error = { message: error.message };
  }
  if (ui.dialog === d) renderDialog();
}

async function merge(d, force) {
  d.stage = 'merging';
  renderDialog();
  try {
    const result = await api('merge', { agent: d.agentId, force });
    toast(t('merge.done', { branch: result.branch, target: result.target }), 'success');
    closeDialog();
    void askForStar('merged');
  } catch (error) {
    d.stage = 'error';
    d.error = { message: error.message, files: error.files };
    d.canForce = error.code === 'TROUPE_GATE_FAILED';
    if (ui.dialog === d) renderDialog();
  }
}

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

function goalFields(goal) {
  return { title: goal.title, outcome: goal.outcome, criteria: goal.criteria, boundaries: goal.boundaries, questions: goal.questions, assignees: goal.assignees, maxIterations: goal.maxIterations };
}

/** Same checks as the engine's arm gate, for showing what is missing before a click. */
function goalProblems(goal, approving) {
  const problems = [];
  if (!goal.title) problems.push('title');
  if (!goal.outcome) problems.push('outcome');
  if (!goal.criteria?.length) problems.push('criteria');
  if (goal.criteria?.length && !goal.criteria.some((c) => c.check || c.review)) problems.push('independent check (a command or a review by another agent)');
  for (const c of goal.criteria || []) if (c.review && goal.assignees?.includes(c.review.by)) problems.push(`@${c.review.by} reviews its own work (${c.id})`);
  if (!goal.assignees?.length) problems.push('assignees');
  if (goal.questions?.some((q) => !q.answer)) problems.push(`open questions: ${goal.questions.filter((q) => !q.answer).map((q) => q.text).join(' / ')}`);
  if (!approving && goal.approvedRevision !== goal.revision) problems.push('approval of this revision');
  return problems;
}

function goalsDialog(d) {
  const goals = store.goals();
  const goal = d.creating ? null : goals.find((g) => g.id === d.goalId) || goals[0] || null;
  if (goal) d.goalId = goal.id;
  const list = h(
    'div',
    { class: 'goal-list' },
    goals.map((g) => h('button', { class: g === goal && !d.creating ? 'selected' : '', onclick: () => ((d.goalId = g.id), (d.creating = false), (d.editing = false), renderDialog()) }, h('span', {}, g.title || '…'), h('span', { class: 'muted' }, t(`goal.status.${g.status}`)))),
    h('button', { onclick: () => ((d.creating = true), (d.editing = true), (d.json = JSON.stringify({ ...GOAL_TEMPLATE, assignees: [selectedAgent()?.name || 'claude'] }, null, 2)), renderDialog()) }, `+ ${t('gui.newGoal')}`),
    h('button', { onclick: () => ((d.drafting = true), renderDialog()) }, t('gui.draft')),
  );
  let detail;
  if (d.drafting) detail = draftForm(d);
  else if (d.editing) detail = goalEditor(d, goal);
  else if (goal) detail = goalDetail(d, goal);
  else detail = h('p', { class: 'muted' }, t('gui.goalsNone'));
  return dialogFrame(t('goals.title'), h('div', { class: 'goals' }, list, h('div', {}, detail)));
}

function goalDetail(d, goal) {
  const problems = goalProblems(goal, false);
  let manual = 0;
  return [
    h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, goal.title), h('span', { class: 'pill' }, t(`goal.status.${goal.status}`)), h('span', { class: 'muted' }, `r${goal.revision}${goal.approvedRevision === goal.revision ? ' ✓' : ''}`)),
    h('div', { class: 'field' }, h('label', {}, t('goal.outcome')), h('div', {}, goal.outcome || '—')),
    h('div', { class: 'field' }, h('label', {}, t('goal.assignees')), h('div', {}, goal.assignees.map((a) => `@${a}`).join(' ') || '—')),
    h('div', { class: 'field' }, h('label', {}, t('goal.criteria'))),
    h(
      'div',
      { class: 'criteria' },
      goal.criteria.map((c) => {
        const results = goal.assignees.map((name) => lastGate(goal, name)?.criteria?.find((r) => r.id === c.id)).filter(Boolean);
        const mark = results.length ? (results.every((r) => r.passed) ? h('span', { class: 'ok' }, '✓') : h('span', { class: 'bad' }, '✗')) : h('span', { class: 'muted' }, '·');
        const how = c.check ? t('goal.byCommand', { command: c.check.run }) : c.review ? t('goal.byReview', { name: c.review.by }) : t('goal.byUser');
        const isManual = !c.check && !c.review;
        if (isManual) manual++;
        return h(
          'div',
          { class: 'criterion' },
          mark,
          h(
            'div',
            {},
            h('b', {}, c.id),
            ' ',
            c.text,
            h('div', { class: 'how' }, how),
            isManual ? h('label', { class: 'muted' }, h('input', { type: 'checkbox', checked: Boolean(goal.confirmations?.[c.id]), onchange: (event) => attempt(api('goalConfirm', { id: goal.id, criterion: c.id, confirmed: event.target.checked })) }), ` ${t('gui.confirm')}`) : null,
            results.filter((r) => !r.passed).map((r) => h('div', { class: 'summary' }, r.summary)),
          ),
        );
      }),
    ),
    goal.boundaries?.length ? h('div', { class: 'field' }, h('label', {}, t('goal.boundaries')), h('ul', {}, goal.boundaries.map((b) => h('li', {}, b)))) : null,
    problems.length ? h('div', { class: 'problems' }, h('b', {}, t('goal.problems')), h('ul', {}, problems.map((p) => h('li', {}, p)))) : null,
    h(
      'div',
      { class: 'dialog-actions' },
      h('button', { onclick: () => ((d.editing = true), (d.json = JSON.stringify(goalFields(goal), null, 2)), renderDialog()) }, t('gui.json')),
      h('button', { disabled: goalProblems(goal, true).length > 0 || goal.approvedRevision === goal.revision, onclick: () => attempt(api('goalApprove', { id: goal.id }), `${t('gui.approve')} ✓`) }, t('gui.approve')),
      h('button', { class: 'primary', disabled: problems.length > 0 || goal.status === 'running', onclick: () => attempt(api('goalStart', { id: goal.id }), () => (closeDialog(), `${t('gui.start')}: ${goal.title}`)) }, t('gui.start')),
      h('button', { onclick: () => attempt(api('goalCheck', { id: goal.id }), (gates) => gates.map((g) => `@${g.agent} ${g.passed ? '✓' : '✗'}`).join(' ')) }, t('gui.check')),
      goal.status === 'running' ? h('button', { onclick: () => attempt(api('goalPause', { id: goal.id })) }, t('gui.pause')) : null,
      h('button', { class: 'danger', onclick: () => confirm(`${t('gui.delete')}: ${goal.title}?`) && attempt(api('goalDelete', { id: goal.id })) }, t('gui.delete')),
    ),
  ];
}

function goalEditor(d, goal) {
  const area = h('textarea', { class: 'json', spellcheck: 'false' });
  area.value = d.json || '';
  area.addEventListener('input', () => (d.json = area.value));
  return [
    h('div', { class: 'field' }, h('label', {}, t('gui.json')), area),
    d.error ? h('div', { class: 'problems' }, d.error) : null,
    h(
      'div',
      { class: 'dialog-actions' },
      h(
        'button',
        {
          class: 'primary',
          onclick: async () => {
            let value;
            try {
              value = JSON.parse(d.json);
            } catch (error) {
              d.error = error.message;
              return renderDialog();
            }
            const saved = await attempt(api('goalSave', { goal: goal && !d.creating ? { ...value, id: goal.id } : value }), t('notice.goalSaved'));
            if (saved) Object.assign(d, { editing: false, creating: false, error: null, goalId: saved.id });
            renderDialog();
          },
        },
        t('gui.save'),
      ),
      h('button', { class: 'ghost', onclick: () => ((d.editing = false), (d.creating = false), (d.error = null), renderDialog()) }, t('merge.cancel')),
    ),
  ];
}

function draftForm(d) {
  const agents = [...store.agents().map((a) => a.name), ...store.state.providers.filter((p) => p.available).map((p) => p.id)];
  const who = h('select', {}, [...new Set(agents)].map((name) => h('option', { value: name }, `@${name}`)));
  const what = h('textarea', { rows: 4, placeholder: t('goal.draftPrompt') });
  return [
    h('div', { class: 'field' }, h('label', {}, t('gui.agents')), who),
    h('div', { class: 'field' }, h('label', {}, t('goal.outcome')), what),
    h(
      'div',
      { class: 'dialog-actions' },
      h(
        'button',
        {
          class: 'primary',
          onclick: async (event) => {
            event.target.disabled = true;
            toast(`@${who.value} …`, 'info');
            const goal = await attempt(api('goalDraft', { agent: who.value, description: what.value }), (g) => `${t('notice.goalSaved')}: ${g.title}`);
            if (goal) Object.assign(d, { drafting: false, goalId: goal.id });
            if (ui.dialog === d) renderDialog();
          },
        },
        t('gui.draft'),
      ),
      h('button', { class: 'ghost', onclick: () => ((d.drafting = false), renderDialog()) }, t('merge.cancel')),
    ),
  ];
}

function boardDialog() {
  const entries = store.state.board.entries || [];
  const key = h('input', { type: 'text', placeholder: 'key (e.g. plan, api.orders)' });
  const value = h('textarea', { rows: 3, placeholder: '…' });
  return dialogFrame(t('board.title'), [
    entries.length
      ? entries.map((e) => h('div', { class: 'board-entry' }, h('div', { class: 'row' }, h('span', { class: 'key' }, e.key), h('span', { class: 'by' }, `@${e.author} · ${new Date(e.at).toLocaleString()}`)), h('p', {}, e.value)))
      : h('p', { class: 'muted' }, t('board.empty')),
    h('div', { class: 'field' }, key, value, h('div', { class: 'dialog-actions' }, h('button', { onclick: () => attempt(api('boardWrite', { key: key.value.trim(), value: value.value })).then(() => renderDialog()) }, t('gui.save')))),
  ]);
}

function newDialog(d) {
  const providers = store.state.providers;
  d.mode ||= store.state.defaults?.mode || 'workspace';
  const mode = h('select', { onchange: (event) => (d.mode = event.target.value) }, MODES.map((m) => h('option', { value: m, selected: m === d.mode }, `${t(`mode.${m}`)} — ${t(`mode.describe.${m}`)}`)));
  const name = h('input', { type: 'text', placeholder: lang === 'zh' ? '名称（可选）' : 'name (optional)' });
  return dialogFrame(t('new.title'), [
    h('div', { class: 'row' }, h('div', { class: 'field', style: 'flex:1;min-width:200px' }, h('label', {}, t('gui.mode')), mode), h('div', { class: 'field', style: 'flex:1;min-width:160px' }, h('label', {}, t('gui.rename')), name)),
    h(
      'div',
      { class: 'providers' },
      providers.length
        ? providers.map((p) =>
            h(
              'button',
              {
                class: `provider${p.available ? '' : ' unavailable'}`,
                disabled: !p.available,
                title: p.available ? '' : p.fix || p.reason,
                onclick: () =>
                  attempt(api('createAgent', { provider: p.id, mode: d.mode, name: name.value.trim() || null })).then((view) => {
                    if (!view) return;
                    closeDialog();
                    select(view.id);
                    input.focus();
                  }),
              },
              h('div', { class: 'pname' }, `@${p.id}`),
              h('div', { class: 'pmeta' }, `${p.name}${p.version ? ` ${p.version}` : ''}`),
              h('div', { class: 'pmeta' }, p.available ? (p.verified ? p.protocol : `${p.protocol} · ${t('new.untested')}`) : p.fix || t('new.unavailable')),
            ),
          )
        : h('p', { class: 'muted' }, '…'),
    ),
  ]);
}

function renameDialog(d) {
  const agent = store.state.agents.get(d.agentId);
  const field = h('input', { type: 'text', value: agent?.name || '' });
  const save = () => attempt(api('rename', { agent: d.agentId, name: field.value.trim() })).then((view) => view && closeDialog());
  field.addEventListener('keydown', (event) => event.key === 'Enter' && !event.isComposing && save());
  return dialogFrame(t('rename.prompt', { name: agent?.name || '' }), [field, h('div', { class: 'dialog-actions' }, h('button', { class: 'primary', onclick: save }, t('gui.save')))]);
}

// ── toasts and start ────────────────────────────────────────────────────

function starDialog(d) {
  const answer = (choice) => {
    d.answered = true;
    void starRequest('POST', choice).catch(() => {});
    closeDialog();
  };
  const star = () => {
    window.open(d.url, '_blank', 'noopener,noreferrer');
    toast(t('star.thanks'), 'success');
    answer('star');
  };
  return dialogFrame(`★ ${t('star.title')}`, [
    h('p', {}, t('star.body')),
    h('p', { class: 'muted mono' }, d.url),
    h('div', { class: 'dialog-actions' }, h('button', { class: 'primary', onclick: star }, `★ ${t('star.open')}`), h('button', { onclick: () => answer('later') }, t('star.later')), h('button', { class: 'ghost', onclick: () => answer('never') }, t('star.never'))),
  ]);
}

function toast(text, level = 'info') {
  if (!text) return;
  const node = h('div', { class: `toast ${level}` }, text);
  $('toasts').append(node);
  setTimeout(() => node.remove(), level === 'error' ? 9000 : 5000);
}

setInterval(() => {
  const agent = selectedAgent();
  if (agent && (agent.state === 'running' || agent.state === 'starting')) invalidate('live');
}, 1000);

document.title = 'Troupe';
$('send').textContent = t('gui.send');
updatePlaceholder();
invalidate('all');
if (!token) {
  const banner = $('banner');
  banner.hidden = false;
  banner.textContent = t('gui.disconnected');
} else {
  void connect();
}
if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', () => Notification.requestPermission().catch(() => {}), { once: true });
}
