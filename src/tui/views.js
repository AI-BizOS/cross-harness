// Pure rendering: (store, ui state, terminal size) → rows. Nothing here reads the
// clock or the terminal directly, so every screen can be tested as plain text.
import { formatCount, formatDuration, oneLine, wrap } from '../util/text.js';
import { clusterWidth, displayWidth, graphemes } from '../util/width.js';
import { fitSpans, plain, renderLine, span, spansWidth } from './screen.js';
import { lastGate } from './store.js';
import { engineText } from '../i18n/strings.js';

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const AGENT_COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'brightCyan', 'brightMagenta', 'brightGreen'];
const GOAL_COLORS = { draft: 'gray', approved: 'blue', running: 'yellow', met: 'green', 'needs-you': 'brightRed', failed: 'red' };
const KIND_GLYPH = { command: '$', edit: '✎', read: '◇', search: '⌕', thinking: '…', tool: '⚙' };

export function agentColor(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AGENT_COLORS[hash % AGENT_COLORS.length];
}

/** Columns [start, end) of a span line, padding where a wide character is cut. */
export function sliceSpans(spans, start, end) {
  const out = [];
  let col = 0;
  for (const s of spans) {
    let text = '';
    for (const cluster of graphemes(s.text)) {
      const w = clusterWidth(cluster);
      const from = col;
      col += w;
      if (col <= start || from >= end) continue;
      if (from < start || col > end) text += ' '.repeat(Math.min(col, end) - Math.max(from, start));
      else text += cluster;
    }
    if (text) out.push({ text, styles: s.styles });
    if (col >= end) break;
  }
  const width = spansWidth(out);
  if (width < end - start) out.push(span(' '.repeat(end - start - width)));
  return out;
}

function spaced(left, right, width) {
  const gap = width - spansWidth(left) - spansWidth(right);
  if (gap < 1) return fitSpans([...left, span(' '), ...right], width);
  return [...left, span(' '.repeat(gap)), ...right];
}

function stateLabel(agent, t) {
  if (agent.checking) return { text: t('state.checking'), color: 'yellow' };
  if (agent.needsYou) return { text: `! ${agent.needsYou}`, color: 'brightYellow' };
  if (agent.waitingOn) return { text: t('state.waitingOn', { name: agent.waitingOn }), color: 'magenta' };
  if (agent.waitingForSlot) return { text: t('state.slot'), color: 'gray' };
  const colors = { running: 'cyan', starting: 'cyan', idle: 'green', stopped: 'yellow', failed: 'red', offline: 'gray', archived: 'gray' };
  return { text: t(`state.${agent.state}`), color: colors[agent.state] || 'gray' };
}

function stateGlyph(agent, frame) {
  if (agent.needsYou) return span('!', 'bold', 'brightYellow');
  if (agent.state === 'running' || agent.state === 'starting' || agent.checking) return span(SPINNER[frame % SPINNER.length], 'cyan');
  return {
    idle: span('○', 'green'),
    stopped: span('■', 'yellow'),
    failed: span('✖', 'red'),
    offline: span('◌', 'gray'),
    archived: span('·', 'gray'),
  }[agent.state] || span('○', 'gray');
}

function secondary(agent, t) {
  if (agent.activity) return `${KIND_GLYPH[agent.activity.kind] || '·'} ${agent.activity.title}`;
  if (agent.progress) return agent.progress;
  if (agent.queue) return agent.queuePaused ? t('state.paused', { n: agent.queue }) : t('state.queued', { n: agent.queue });
  if (agent.error) return agent.error.message;
  return agent.branch || t('agent.shared');
}

// ── header, sidebar, footer ─────────────────────────────────────────────

function header({ store, ui, t }, width) {
  const s = store.state;
  const counts = store.counts();
  const project = s.project;
  const left = [span(' Troupe ', 'bold'), span('│ ', 'dim'), span(project?.name || '', 'bold')];
  if (project?.branch) left.push(span(` (${project.branch})`, 'dim'));
  left.push(span('  ·  ', 'dim'), span(t('header.agents', { n: counts.agents })));
  if (counts.working) left.push(span('  ·  ', 'dim'), span(t('header.working', { n: counts.working }), 'cyan'));
  if (counts.waiting) left.push(span('  ·  ', 'dim'), span(t('header.needsYou', { n: counts.waiting }), 'bold', 'brightYellow'));
  const goal = store.activeGoal();
  if (goal) left.push(span('  ·  ', 'dim'), span(`◆ ${goal.title} · ${t(`goal.status.${goal.status}`)}`, GOAL_COLORS[goal.status]));
  const right = [];
  if (ui.update) right.push(span(`${t('update.badge', ui.update)} `, 'green'));
  if (ui.remote) right.push(span(`${t('header.remote')} `, 'magenta'));
  return spaced(left, right, width);
}

function sidebar({ store, ui, t, frame }, width, height) {
  const rows = [];
  const agents = store.agents();
  rows.push([span(` ${t('gui.agents').toUpperCase()}`, 'bold', 'dim')]);
  const agentRows = [];
  for (const agent of agents) {
    const selected = agent.id === ui.selected;
    const label = stateLabel(agent, t);
    const name = [span(selected ? '▶' : ' ', 'cyan'), stateGlyph(agent, frame), span(' '), span(`@${agent.name}`, 'bold', agentColor(agent.name))];
    agentRows.push({ id: agent.id, line: spaced(name, [span(`${label.text} `, label.color)], width) });
    agentRows.push({ id: agent.id, line: fitSpans([span(`    ${oneLine(secondary(agent, t), 120)}`, 'dim')], width) });
  }
  // Keep the selected agent visible when the list is longer than the column.
  const room = Math.max(2, height - 8);
  let first = 0;
  const index = agentRows.findIndex((r) => r.id === ui.selected);
  if (index >= room) first = Math.min(index - room + 2, agentRows.length - room);
  for (const row of agentRows.slice(first, first + room)) rows.push(row.line);
  if (!agents.length) rows.push([span(`  ${t('state.idle')}…`, 'dim')]);
  const waiting = store.waiting();
  rows.push([]);
  if (waiting.length) {
    rows.push([span(` ${t('gui.approvals').toUpperCase()} (${waiting.length})`, 'bold', 'brightYellow')]);
    for (const w of waiting.slice(0, 3)) {
      const text = w.type === 'approval' ? w.item.command || w.item.title : w.item.question;
      rows.push(fitSpans([span(`  @${w.item.agentName}: `, 'yellow'), span(oneLine(text, 80), 'dim')], width));
    }
    rows.push([]);
  }
  const goals = store.goals().slice(0, 3);
  if (goals.length) {
    rows.push([span(` ${t('goals.title').toUpperCase()}`, 'bold', 'dim')]);
    for (const goal of goals) rows.push(fitSpans([span('  ◆ ', GOAL_COLORS[goal.status]), span(goal.title), span(` · ${t(`goal.status.${goal.status}`)}`, 'dim')], width));
    rows.push([]);
  }
  const boardCount = store.state.board.entries?.length || 0;
  rows.push([span(` ${t('board.title').toUpperCase()} (${boardCount})`, 'bold', 'dim')]);
  return rows.slice(0, height);
}

function footer({ ui, t, now }, width) {
  if (ui.notice && ui.notice.until > now) {
    const color = { error: 'red', warn: 'yellow', success: 'green' }[ui.notice.level] || 'cyan';
    return fitSpans([span(' '), span(ui.notice.text, color)], width);
  }
  const hint = ui.modal ? ui.modal.hint || t('footer.modal') : ui.focus === 'composer' ? t('footer.compose') : t('footer.nav');
  return fitSpans([span(` ${hint}`, 'dim')], width);
}

// ── transcript ──────────────────────────────────────────────────────────

const ROLE_HEAD = {
  user: (entry, agent, t) => [span(t('role.you'), 'bold', 'blue')],
  question: (entry, agent, t) => [span(t('role.asks', { name: entry.from?.name || '?' }), 'bold', 'magenta')],
  feedback: (entry, agent, t) => [span(t('role.feedback'), 'bold', 'yellow')],
  review: (entry, agent, t) => [span(t('role.review'), 'bold', 'yellow')],
  compare: (entry, agent, t) => [span(t('role.compare'), 'bold', 'yellow')],
  draft: (entry, agent, t) => [span(t('role.draft'), 'bold', 'yellow')],
  assistant: (entry, agent) => [span(`@${agent.name}`, 'bold', agentColor(agent.name))],
};

function bodyLines(text, width, { code = true } = {}) {
  const out = [];
  let inCode = false;
  for (const raw of String(text || '').split('\n')) {
    if (code && /^\s*```/.test(raw)) {
      inCode = !inCode;
      out.push([span('  '), span(raw.trim() || '```', 'gray')]);
      continue;
    }
    const style = inCode ? ['gray'] : /^\s{0,3}#{1,6}\s/.test(raw) ? ['bold'] : [];
    for (const line of wrap(raw, Math.max(8, width - 2))) out.push([span('  '), span(line, ...style)]);
  }
  return out;
}

function activityLines(activities, width, { limit = 4, frame = 0 } = {}) {
  const out = [];
  const list = activities.filter((a) => a.kind !== 'thinking');
  const shown = list.slice(-limit);
  if (list.length > shown.length) out.push([span(`  … +${list.length - shown.length}`, 'dim')]);
  for (const a of shown) {
    const glyph = a.status === 'running' ? span(SPINNER[frame % SPINNER.length], 'cyan') : a.status === 'failed' ? span('✗', 'red') : span('✓', 'green');
    const line = [span('  '), glyph, span(` ${KIND_GLYPH[a.kind] || '·'} `, 'dim'), span(oneLine(a.title, 200), 'dim')];
    if (a.detail && a.detail !== a.title) line.push(span(`  ${oneLine(a.detail, 200)}`, 'gray'));
    out.push(fitSpans(line, width));
  }
  return out;
}

function entryLines(entry, agent, width, t) {
  const lines = [];
  if (entry.params) entry = { ...entry, text: engineText(entry, t) };
  if (entry.role === 'system') {
    for (const line of wrap(`· ${entry.text}`, width)) lines.push([span(line, 'dim')]);
    if (entry.activities?.length) lines.push(...activityLines(entry.activities, width));
    return lines;
  }
  if (entry.role === 'error') {
    const text = entry.code ? `${entry.text} (${entry.code})` : entry.text;
    for (const line of wrap(`✖ ${text}`, width)) lines.push([span(line, 'red')]);
    if (entry.activities?.length) lines.push(...activityLines(entry.activities, width));
    return lines;
  }
  if (entry.role === 'gate') {
    const passed = entry.gate?.passed;
    lines.push([span(passed ? '◆ ' : '◇ ', passed ? 'green' : 'red'), span(`${t('role.gate')}: `, 'bold'), span(entry.text, passed ? 'green' : 'red')]);
    for (const c of entry.gate?.criteria || []) {
      lines.push(fitSpans([span(`  ${c.passed ? '✓' : '✗'} `, c.passed ? 'green' : 'red'), span(`${c.id}: `, 'bold'), span(oneLine(c.summary, 200), 'dim')], width));
    }
    return lines;
  }
  const head = (ROLE_HEAD[entry.role] || ROLE_HEAD.user)(entry, agent, t);
  const meta = [];
  if (entry.durationMs) meta.push(formatDuration(entry.durationMs));
  if (entry.kind === 'steer') meta.push('steer');
  lines.push([...head, span(' ›', 'dim'), ...(meta.length ? [span(`  ${meta.join(' · ')}`, 'dim')] : [])]);
  lines.push(...bodyLines(entry.text, width, { code: entry.role === 'assistant' }));
  if (entry.activities?.length) lines.push(...activityLines(entry.activities, width));
  return lines;
}

function liveLines(agent, live, width, { t, now, frame }) {
  const lines = [];
  const elapsed = agent.turnStartedAt ? formatDuration(now - agent.turnStartedAt) : '';
  const head = [span(SPINNER[frame % SPINNER.length], 'cyan'), span(' '), span(`@${agent.name}`, 'bold', agentColor(agent.name)), span(` ${t('agent.liveTurn', { time: elapsed })}`, 'dim')];
  if (agent.currentInput?.from && agent.currentInput.kind === 'question') head.push(span(` · ${t('role.asks', { name: agent.currentInput.from })}`, 'magenta'));
  lines.push(head);
  if (agent.waitingOn) lines.push([span(`  ⧗ ${t('state.waitingOn', { name: agent.waitingOn })}`, 'magenta')]);
  if (agent.needsYou) lines.push([span(`  ! ${t('header.needsYou', { n: agent.needsYou })} — Esc, a`, 'bold', 'brightYellow')]);
  const plan = live?.plan?.length ? live.plan : agent.plan || [];
  for (const step of plan.slice(0, 8)) {
    const mark = step.status === 'completed' ? '☑' : step.status === 'in_progress' ? '◐' : '☐';
    lines.push(fitSpans([span(`  ${mark} `, step.status === 'in_progress' ? 'yellow' : 'dim'), span(oneLine(step.content, 200), step.status === 'in_progress' ? 'bold' : 'dim')], width));
  }
  const activities = live ? [...live.activities.values()] : agent.activity ? [{ ...agent.activity, status: 'running' }] : [];
  lines.push(...activityLines(activities, width, { limit: 6, frame }));
  const text = live?.text || agent.text;
  if (text) lines.push(...bodyLines(text, width));
  return lines;
}

/** Every line of an agent's pane, oldest first (wrapped lines are cached per width). */
export function transcriptLines({ store, ui, t, now, frame }, agent, width) {
  const entries = store.state.transcripts.get(agent.id) || [];
  const lines = [];
  for (const entry of entries) {
    const key = `${entry.id}:${width}:${agent.name}`;
    let cached = ui.wrapCache?.get(key);
    if (!cached) {
      cached = entryLines(entry, agent, width, t);
      ui.wrapCache?.set(key, cached);
    }
    if (lines.length) lines.push([]);
    lines.push(...cached);
  }
  if (agent.state === 'running' || agent.state === 'starting' || agent.checking) {
    if (lines.length) lines.push([]);
    lines.push(...liveLines(agent, store.state.live.get(agent.id), width, { t, now, frame }));
  }
  if (!lines.length) lines.push([span(store.state.loaded.has(agent.id) ? t('empty.transcript') : '…', 'dim')]);
  return lines;
}

function welcome({ store, t }, width) {
  const lines = [[], [span('  Troupe', 'bold', 'cyan'), span(` — ${t('app.tagline')}`, 'dim')], []];
  for (const line of wrap(t('empty.noAgents'), width - 4)) lines.push([span(`  ${line}`)]);
  lines.push([]);
  const available = store.state.providers.filter((p) => p.available);
  for (const p of available.slice(0, 12)) {
    lines.push(fitSpans([span(`    @${p.id}`.padEnd(16), 'bold', agentColor(p.id)), span(`${p.name}${p.version ? ` ${p.version}` : ''}`, 'dim'), ...(p.verified ? [] : [span(`  ${t('provider.untested')}`, 'yellow')])], width));
  }
  lines.push([]);
  for (const example of ['@codex @claude review src/', '@codex fix the failing test', '@kimi add edge-case tests', '@all @compare:claude which approach is simpler?']) {
    lines.push([span(`    ${example}`, 'gray')]);
  }
  return lines;
}

function mainPane(ctx, width, height) {
  const { store, ui, t } = ctx;
  const agent = ui.selected ? store.state.agents.get(ui.selected) : null;
  if (!agent) return { lines: welcome(ctx, width).slice(0, height), info: null };
  const title = [span(' '), span(`@${agent.name}`, 'bold', agentColor(agent.name)), span(` · ${agent.providerName}`, 'dim')];
  if (ctx.narrow) {
    // Without the sidebar, say where in the list this agent is (↑↓ in key mode moves).
    const list = store.agents();
    title.splice(1, 0, span(`${list.findIndex((a) => a.id === agent.id) + 1}/${list.length} `, 'dim'));
  }
  if (!agent.verified) title.push(span(` · ${t('provider.untested')}`, 'yellow'));
  title.push(span(` · ${t(`mode.${agent.mode}`)}`, agent.mode === 'full' ? 'red' : agent.mode === 'plan' ? 'blue' : 'dim'));
  title.push(span(` · ${agent.branch || t('agent.shared')}`, 'dim'));
  const tokens = (agent.usage?.input_tokens || 0) + (agent.usage?.output_tokens || 0);
  const label = stateLabel(agent, t);
  const right = [...(tokens ? [span(`${formatCount(tokens)} tok  `, 'dim')] : []), span(`${label.text} `, label.color)];
  const lines = [spaced(title, right, width), [span('─'.repeat(width), 'dim')]];
  const all = transcriptLines(ctx, agent, width - 1).map((line) => [span(' '), ...line]);
  const visible = Math.max(1, height - 2);
  const maxOffset = Math.max(0, all.length - visible);
  const offset = Math.min(ui.scroll?.get(agent.id) || 0, maxOffset);
  ui.scroll?.set(agent.id, offset);
  const window = all.slice(Math.max(0, all.length - visible - offset), all.length - offset);
  if (offset > 0 && window.length) window[window.length - 1] = [span(` ↓ ${offset} · End`, 'dim', 'inverse')];
  lines.push(...window);
  return { lines, info: { total: all.length, visible, offset } };
}

// ── composer ────────────────────────────────────────────────────────────

function composer({ ui, store, t }, width, maxRows = 6) {
  const focused = ui.focus === 'composer' && !ui.modal;
  const layout = ui.editor.layout(width, 2);
  const limit = Math.max(1, maxRows);
  const count = Math.min(limit, layout.rows.length);
  const first = Math.max(0, Math.min(layout.cursorRow - count + 1, layout.rows.length - count));
  const rows = layout.rows.slice(first, first + count);
  const lines = [];
  const target = ui.selected ? store.state.agents.get(ui.selected) : null;
  const empty = !ui.editor.text;
  rows.forEach((row, i) => {
    const prompt = i === 0 ? span('› ', focused ? 'bold' : 'dim', 'cyan') : span('  ');
    if (empty && i === 0) {
      const hint = target ? t('composer.placeholderTo', { name: target.name }) : t('composer.placeholder');
      lines.push(fitSpans([prompt, span(hint, 'gray')], width));
    } else lines.push(fitSpans([prompt, span(row)], width, { ellipsis: false }));
  });
  return { lines, cursor: focused ? { row: layout.cursorRow - first, col: layout.cursorCol } : null };
}

function completionPopup({ ui }, width) {
  const c = ui.completion;
  if (!c?.items?.length) return [];
  const w = Math.min(width - 2, 56);
  return c.items.slice(0, 7).map((item, i) => {
    const selected = i === c.index;
    const line = [span(` @${item.name}`.padEnd(16), 'bold', item.kind === 'special' ? 'yellow' : agentColor(item.name)), span(item.detail || '', item.available === false ? 'gray' : 'dim')];
    return { spans: fitSpans(line, w), selected, width: w };
  });
}

// ── modals ──────────────────────────────────────────────────────────────

function box(title, body, { width, right = null, footerHint = null }) {
  const inner = width - 4;
  const top = [span('┌─ ', 'dim'), span(title, 'bold')];
  const rightSpans = right ? [span(` ${right} `, 'dim')] : [];
  const fill = width - spansWidth(top) - spansWidth(rightSpans) - 1;
  const lines = [[...top, span(` ${'─'.repeat(Math.max(0, fill - 1))}`, 'dim'), ...rightSpans, span('┐', 'dim')]];
  for (const line of body) lines.push([span('│ ', 'dim'), ...fitSpans(line, inner), span(' │', 'dim')]);
  if (footerHint) {
    lines.push([span(`├${'─'.repeat(width - 2)}┤`, 'dim')]);
    lines.push([span('│ ', 'dim'), ...fitSpans([span(footerHint, 'dim')], inner), span(' │', 'dim')]);
  }
  lines.push([span(`└${'─'.repeat(width - 2)}┘`, 'dim')]);
  return lines;
}

function wrapped(text, width, ...styles) {
  return wrap(String(text ?? ''), Math.max(4, width)).map((line) => [span(line, ...styles)]);
}

function scrolled(lines, height, scroll = 0) {
  const max = Math.max(0, lines.length - height);
  const offset = Math.min(Math.max(0, scroll), max);
  return { lines: lines.slice(offset, offset + height), offset, max };
}

function waitingModal({ store, ui, t }, width, height) {
  const waiting = store.waiting();
  const index = Math.min(ui.modal.index || 0, waiting.length - 1);
  if (!waiting.length) return box(t('approval.title'), [[span(t('notice.nothingPending'), 'dim')]], { width });
  const w = waiting[index];
  const inner = width - 4;
  const body = [];
  if (w.type === 'approval') {
    const a = w.item;
    body.push([span(`@${a.agentName}`, 'bold', agentColor(a.agentName)), span(` · ${t(`approval.kind.${a.kind}`)}`, 'yellow')], []);
    body.push(...wrapped(a.command || a.title, inner, 'bold'));
    if (a.detail && a.detail !== a.command && a.detail !== a.title) {
      body.push([]);
      body.push(...wrapped(a.detail, inner, 'dim').slice(0, Math.max(3, height - 16)));
    }
    body.push([]);
    body.push([span('[1] ', 'bold', 'green'), span(t('approval.allowOnce'))]);
    body.push([span('[2] ', 'bold', 'green'), span(t('approval.allowAlways', { name: a.agentName }))]);
    body.push([span('[3] ', 'bold', 'red'), span(t('approval.deny'))]);
    body.push([span('[Esc] ', 'dim'), span(t('approval.later'), 'dim')]);
    return box(t('approval.title'), body, { width, right: t('approval.count', { i: index + 1, n: waiting.length }), footerHint: '1 · 2 · 3 · ← → · Esc' });
  }
  const d = w.item;
  body.push(...wrapped(d.question, inner));
  body.push([]);
  (d.options || []).forEach((option, i) => body.push([span(`[${i + 1}] `, 'bold', 'cyan'), span(option)]));
  if (d.options?.length) body.push([]);
  const text = ui.modal.input?.text || '';
  body.push([span('› ', 'bold', 'cyan'), span(text || t('decision.type'), text ? '' : 'gray')]);
  return box(t('decision.title', { name: d.agentName }), body, { width, right: t('approval.count', { i: index + 1, n: waiting.length }), footerHint: `${d.options?.length ? '1-' + d.options.length + ' · ' : ''}Enter · ← → · Esc` });
}

function diffModal({ ui, t }, width, height) {
  const m = ui.modal;
  const inner = width - 4;
  if (!m.diff) return box(t('diff.title', { name: m.agentName }), [[span(m.error || '…', m.error ? 'red' : 'dim')]], { width });
  const d = m.diff;
  const body = [];
  const facts = [];
  if (d.isolated) facts.push(t('diff.branch', { branch: d.branch || m.branch || '', base: d.base }));
  if (d.commits) facts.push(t('diff.commits', { n: d.commits }));
  if (d.uncommitted) facts.push(t('diff.uncommitted'));
  if (facts.length) body.push([span(facts.join(' · '), 'dim')]);
  if (!d.isolated && d.note) body.push(...wrapped(t('diff.shared'), inner, 'dim'));
  for (const f of d.files || []) {
    const glyph = f.status === 'added' ? span('+ ', 'green') : f.status === 'deleted' ? span('- ', 'red') : span('~ ', 'yellow');
    body.push([glyph, span(f.path), span(`  ${f.added ?? '?'}+ ${f.removed ?? '?'}-`, 'dim')]);
  }
  const patch = [];
  for (const raw of String(d.patch || '').split('\n')) {
    for (const line of wrap(raw, inner)) {
      const style = /^\+\+\+|^---|^diff |^index /.test(raw) ? ['bold'] : raw.startsWith('+') ? ['green'] : raw.startsWith('-') ? ['red'] : raw.startsWith('@@') ? ['cyan'] : ['dim'];
      patch.push([span(line, ...style)]);
    }
  }
  if (!d.files?.length && !d.patch) body.push([span(t('diff.none'), 'dim')]);
  if (d.truncated) patch.push([span(t('diff.truncated'), 'yellow')]);
  const room = Math.max(3, height - body.length - 6);
  const view = scrolled(patch, room, m.scroll);
  m.scroll = view.offset;
  if (patch.length) body.push([], ...view.lines);
  return box(t('diff.title', { name: m.agentName }), body, { width, right: patch.length > room ? `${view.offset + 1}-${Math.min(patch.length, view.offset + room)}/${patch.length}` : null, footerHint: `↑↓ PgUp PgDn · m ${t('gui.merge')} · Esc` });
}

function mergeModal({ ui, t, frame }, width) {
  const m = ui.modal;
  const inner = width - 4;
  const body = [];
  const title = t('merge.title', { name: m.agentName, target: m.target || 'main' });
  if (m.stage === 'menu') {
    m.options.forEach((option, i) => body.push([span(i === m.index ? '▶ ' : '  ', 'cyan'), span(t(option.label), i === m.index ? 'bold' : '')]));
    return box(title, body, { width, footerHint: '↑↓ · Enter · Esc' });
  }
  if (m.stage === 'reviewing') {
    body.push([span(SPINNER[frame % SPINNER.length], 'cyan'), span(` ${t('merge.reviewing', { reviewer: m.reviewer || '…' })}`)]);
    return box(title, body, { width, footerHint: 'Esc' });
  }
  if (m.stage === 'verdict') {
    const v = m.verdict;
    body.push([span(t('merge.verdict', { reviewer: v.reviewer, verdict: v.passed ? 'PASS' : 'FAIL' }), 'bold', v.passed ? 'green' : 'red')]);
    body.push(...wrapped(v.summary, inner, 'dim'));
    if (v.answer) {
      body.push([]);
      body.push(...wrapped(v.answer, inner).slice(-12));
    }
    body.push([]);
    body.push([span('[Enter] ', 'bold', v.passed ? 'green' : 'yellow'), span(t('merge.confirm'))]);
    body.push([span('[Esc] ', 'dim'), span(t('merge.cancel'), 'dim')]);
    return box(title, body, { width, footerHint: 'Enter · Esc' });
  }
  if (m.stage === 'merging') {
    body.push([span(SPINNER[frame % SPINNER.length], 'cyan'), span(' git merge…')]);
    return box(title, body, { width });
  }
  if (m.stage === 'error') {
    body.push(...wrapped(m.error.message, inner, 'red'));
    for (const file of (m.error.files || []).slice(0, 12)) body.push([span(`  ${file}`, 'yellow')]);
    body.push([]);
    if (m.canForce) body.push([span('[f] ', 'bold', 'yellow'), span(t('merge.force'))]);
    body.push([span('[Esc] ', 'dim'), span(t('gui.close'), 'dim')]);
    return box(title, body, { width, footerHint: m.canForce ? 'f · Esc' : 'Esc' });
  }
  body.push([span(m.message || '', 'green')]);
  return box(title, body, { width, footerHint: 'Esc' });
}

function goalsModal({ store, ui, t }, width, height) {
  const goals = store.goals();
  const m = ui.modal;
  const inner = width - 4;
  if (!goals.length) return box(t('goals.title'), wrapped(t('goals.none'), inner, 'dim'), { width, footerHint: t('goals.actions') });
  m.index = Math.min(m.index || 0, goals.length - 1);
  const body = [];
  goals.slice(0, 6).forEach((goal, i) => {
    body.push(fitSpans([span(i === m.index ? '▶ ' : '  ', 'cyan'), span('◆ ', GOAL_COLORS[goal.status]), span(goal.title || '(untitled)', i === m.index ? 'bold' : ''), span(` · ${t(`goal.status.${goal.status}`)}`, GOAL_COLORS[goal.status]), span(` · r${goal.revision}`, 'dim')], inner));
  });
  const goal = goals[m.index];
  body.push([span('─'.repeat(inner), 'dim')]);
  body.push([span(`${t('goal.outcome')}: `, 'bold'), ...wrapped(goal.outcome || '—', inner - 10)[0]]);
  body.push([span(`${t('goal.assignees')}: `, 'bold'), span(goal.assignees.map((a) => `@${a}`).join(' ') || '—')]);
  body.push([span(`${t('goal.criteria')}:`, 'bold')]);
  let manual = 0;
  for (const c of goal.criteria) {
    const results = goal.assignees.map((name) => lastGate(goal, name)?.criteria?.find((r) => r.id === c.id)).filter(Boolean);
    const status = results.length ? (results.every((r) => r.passed) ? span('✓ ', 'green') : span('✗ ', 'red')) : span('· ', 'dim');
    const how = c.check ? t('goal.byCommand', { command: c.check.run }) : c.review ? t('goal.byReview', { name: c.review.by }) : `${t('goal.byUser')} [${++manual}]${goal.confirmations?.[c.id] ? ' ✓' : ''}`;
    body.push(fitSpans([span('  '), status, span(`${c.id}: `, 'bold'), span(c.text), span(`  (${how})`, 'dim')], inner));
  }
  if (goal.boundaries?.length) body.push([span(`${t('goal.boundaries')}: `, 'bold'), span(goal.boundaries.join('; '), 'dim')]);
  const open = goal.questions?.filter((q) => !q.answer) || [];
  if (open.length) body.push([span(`${t('goal.questions')}: `, 'bold', 'yellow'), span(open.map((q) => q.text).join(' / '))]);
  if (m.problems?.length && m.problemsFor === goal.id) {
    body.push([span(`${t('goal.problems')}:`, 'bold', 'yellow')]);
    for (const p of m.problems) body.push(...wrapped(`  • ${p.message}`, inner, 'yellow'));
  }
  const gate = lastGate(goal);
  if (gate) body.push([span(t('goal.lastCheck', { result: gate.passed ? '✓' : '✗', n: gate.iteration }), gate.passed ? 'green' : 'red'), span(` @${gate.agent}`, 'dim')]);
  return box(t('goals.title'), body.slice(0, height - 6), { width, footerHint: t('goals.actions') });
}

function boardModal({ store, ui, t }, width, height) {
  const entries = store.state.board.entries || [];
  const inner = width - 4;
  if (!entries.length) return box(t('board.title'), wrapped(t('board.empty'), inner, 'dim'), { width, footerHint: 'Esc' });
  const m = ui.modal;
  m.index = Math.min(m.index || 0, entries.length - 1);
  const body = [];
  entries.slice(0, 8).forEach((e, i) => body.push(fitSpans([span(i === m.index ? '▶ ' : '  ', 'cyan'), span(e.key, 'bold'), span(`  @${e.author} · ${String(e.at).slice(0, 16).replace('T', ' ')}`, 'dim')], inner)));
  body.push([span('─'.repeat(inner), 'dim')]);
  const view = scrolled(wrapped(entries[m.index].value, inner), Math.max(3, height - body.length - 6), m.scroll);
  m.scroll = view.offset;
  body.push(...view.lines);
  return box(t('board.title'), body, { width, footerHint: '↑↓ · PgUp PgDn · Esc' });
}

function newAgentModal({ store, ui, t }, width) {
  const m = ui.modal;
  const providers = store.state.providers;
  const inner = width - 4;
  const body = [];
  if (!providers.length) body.push([span('…', 'dim')]);
  providers.forEach((p, i) => {
    const tag = p.available ? (p.verified ? [] : [span(`  ${t('new.untested')}`, 'yellow')]) : [span(`  ${t('new.unavailable')}`, 'gray')];
    body.push(fitSpans([span(i === m.index ? '▶ ' : '  ', 'cyan'), span(`@${p.id}`.padEnd(14), 'bold', p.available ? agentColor(p.id) : 'gray'), span(`${p.name}${p.version ? ` ${p.version}` : ''}`, p.available ? '' : 'gray'), ...tag], inner));
  });
  const chosen = providers[m.index];
  if (chosen && !chosen.available && chosen.fix) body.push([], ...wrapped(chosen.fix, inner, 'dim'));
  return box(t('new.title'), body, { width, footerHint: t('new.hint') });
}

function helpModal({ t }, width) {
  const rows = [
    ['Enter', 'send the message / open what waits for you'],
    ['Alt+Enter', 'new line in the message'],
    ['Tab', 'complete @agent'],
    ['Esc', 'switch between typing and keys'],
    ['↑ ↓  j k', 'select an agent (keys) · history (typing)'],
    ['PgUp PgDn', 'scroll the conversation'],
    ['a', 'approvals and questions waiting for you'],
    ['d', 'changes made by the agent'],
    ['m', 'review and merge the agent\'s branch'],
    ['s / y / u', 'stop · send the last message again · resume the queue'],
    ['n', 'new agent'],
    ['p / r / x', 'permission mode · rename · archive'],
    ['g / b', 'goals · project board'],
    ['q, Ctrl+C', 'quit'],
  ];
  return box(t('help.title'), rows.map(([key, text]) => [span(key.padEnd(12), 'bold', 'cyan'), span(text)]), { width, footerHint: 'Esc' });
}

function inputModal({ ui }, width) {
  const m = ui.modal;
  const body = [];
  if (m.description) body.push(...wrapped(m.description, width - 4, 'dim'), []);
  body.push([span('› ', 'bold', 'cyan'), span(m.input.text || '')]);
  if (m.error) body.push([], ...wrapped(m.error, width - 4, 'red'));
  return box(m.title, body, { width, footerHint: 'Enter · Esc' });
}

function choiceModal({ ui }, width) {
  const m = ui.modal;
  const body = m.choices.map((choice, i) => fitSpans([span(i === m.index ? '▶ ' : '  ', 'cyan'), span(choice.label, i === m.index ? 'bold' : ''), ...(choice.description ? [span(`  ${choice.description}`, 'dim')] : [])], width - 4));
  return box(m.title, body, { width, footerHint: '↑↓ · Enter · Esc' });
}

function starModal({ ui, t }, width) {
  const body = [...wrapped(t('star.body'), width - 4), [], [span(ui.modal.url, 'cyan', 'underline')], []];
  body.push([span('[Enter] ', 'bold', 'yellow'), span(`★ ${t('star.open')}`, 'bold')]);
  body.push([span('[l] ', 'bold', 'cyan'), span(t('star.later'))]);
  body.push([span('[n] ', 'dim'), span(t('star.never'), 'dim')]);
  return box(`★ ${t('star.title')}`, body, { width, footerHint: 'Enter · l · n · Esc' });
}

const MODALS = { waiting: waitingModal, diff: diffModal, merge: mergeModal, goals: goalsModal, board: boardModal, new: newAgentModal, help: helpModal, input: inputModal, choice: choiceModal, star: starModal };

/**
 * The whole screen.
 * @returns {{rows:string[], cursor:{row:number,col:number}|null, layout:object}}
 */
export function renderApp(ctx) {
  const { size, color = true, ui } = ctx;
  const W = size.columns;
  const H = size.rows;
  const comp = composer(ctx, W, Math.min(6, H - 6));
  const composerHeight = comp.lines.length;
  const bodyHeight = Math.max(3, H - 3 - composerHeight);
  const sideWidth = W >= 72 ? Math.max(24, Math.min(36, Math.floor(W * 0.27))) : 0;
  const mainWidth = W - sideWidth - (sideWidth ? 1 : 0);
  const side = sideWidth ? sidebar(ctx, sideWidth, bodyHeight) : [];
  const main = mainPane({ ...ctx, narrow: !sideWidth }, mainWidth, bodyHeight);
  const lines = [];
  lines.push(header(ctx, W));
  for (let i = 0; i < bodyHeight; i++) {
    const right = fitSpans(main.lines[i] || [], mainWidth);
    lines.push(sideWidth ? [...fitSpans(side[i] || [], sideWidth), span('│', 'dim'), ...right] : right);
  }
  lines.push([span('─'.repeat(W), 'dim')]);
  const composerTop = lines.length;
  lines.push(...comp.lines);
  lines.push(footer(ctx, W));
  let cursor = comp.cursor ? { row: composerTop + comp.cursor.row, col: comp.cursor.col } : null;

  const popup = !ui.modal && ui.focus === 'composer' ? completionPopup(ctx, W) : [];
  popup.forEach((item, i) => {
    const row = composerTop - popup.length - 1 + i;
    if (row < 1) return;
    const styled = item.selected ? item.spans.map((s) => ({ ...s, styles: [...s.styles, 'inverse'] })) : item.spans;
    lines[row] = [...sliceSpans(lines[row], 0, 2), ...styled, ...sliceSpans(lines[row], 2 + item.width, W)];
  });

  if (ui.modal && MODALS[ui.modal.type]) {
    const width = Math.min(W - 2, ui.modal.width || 78);
    const boxLines = MODALS[ui.modal.type](ctx, width, H - 2).slice(0, H - 2);
    const top = Math.max(1, Math.floor((H - boxLines.length) / 2) - 1);
    const left = Math.max(0, Math.floor((W - width) / 2));
    boxLines.forEach((boxLine, i) => {
      const row = top + i;
      if (row >= H - 1) return;
      lines[row] = [...sliceSpans(lines[row], 0, left).map((s) => ({ ...s, styles: [...s.styles, 'dim'] })), ...fitSpans(boxLine, width), ...sliceSpans(lines[row], left + width, W).map((s) => ({ ...s, styles: [...s.styles, 'dim'] }))];
    });
    cursor = null;
    if (ui.modal.input && (ui.modal.type === 'input' || ui.modal.type === 'waiting')) {
      const promptRow = boxLines.findIndex((line) => plain(line).startsWith('│ › '));
      if (promptRow >= 0) {
        const typed = ui.modal.input.text || '';
        cursor = { row: top + promptRow, col: left + 4 + Math.min(displayWidth(typed), width - 6) };
      }
    }
  }
  return { rows: lines.map((line, i) => renderLine(line, W, { color, ellipsis: i !== composerTop })), cursor, layout: { bodyHeight, sideWidth, mainWidth, composerTop, main: main.info } };
}

/** Plain text of a rendered frame, for tests and logs. */
export function frameText(rows) {
  return rows.map((row) => row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+$/, '')).join('\n');
}
