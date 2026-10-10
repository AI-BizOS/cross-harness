#!/usr/bin/env node
// The "How it works" picture in the README, in English and Chinese: interfaces, one
// engine per project, agents through their own protocols, and the file mailbox they
// call Troupe's tools through. Dots show a task going out, a question between two
// agents and an approval coming back to you. Colours follow the light or dark theme.
//
//   node tools/media/diagram.js [--out docs/media]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const out = path.resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'docs/media');

const TEXT = {
  en: {
    label: 'How Troupe works: interfaces talk to one engine per project; the engine reaches each agent through the protocol its vendor ships; agents call Troupe back through a file mailbox.',
    you: 'YOU',
    engine: 'ONE ENGINE PER PROJECT',
    agents: 'AGENTS · THEIR OWN PROTOCOLS',
    ui: [
      ['Terminal UI', 'troupe'],
      ['Web UI', 'troupe gui'],
      ['Scripts and CI', 'troupe run'],
      ['Another machine', 'troupe --ssh host'],
    ],
    client: 'client protocol: in-process, stdio or SSH',
    title: 'Troupe engine',
    protocol: 'troupe/1',
    parts: ['@mentions → tasks', 'one approval queue', 'a git worktree per agent', 'review by another agent', 'goal gates with evidence'],
    harnesses: [
      ['Claude Code', 'stream-json'],
      ['Codex', 'app-server'],
      ['Kimi Code · OpenCode · Gemini CLI', 'ACP'],
      ['Aider · Amp', 'one-shot'],
      ['Your own runner', 'ACP'],
    ],
    mailbox: 'troupe mcp · file mailbox',
    tools: 'ask_agent · ask_user · board · report_progress · goal_status',
    legend: [
      ['task', 'a task'],
      ['ask', 'a question between agents'],
      ['approve', 'an approval for you'],
    ],
  },
  zh: {
    label: 'Troupe 的工作方式：界面连接每个项目唯一的引擎；引擎通过各厂商自己的协议连接代理；代理通过文件信箱回调 Troupe。',
    you: '你',
    engine: '每个项目一个引擎',
    agents: '代理，走各自厂商的协议',
    ui: [
      ['终端界面', 'troupe'],
      ['网页界面', 'troupe gui'],
      ['脚本与 CI', 'troupe run'],
      ['另一台机器', 'troupe --ssh host'],
    ],
    client: '客户端协议：同进程、stdio 或 SSH',
    title: 'Troupe 引擎',
    protocol: 'troupe/1',
    parts: ['@点名 → 派发任务', '统一的审批队列', '每个代理一个 worktree', '由另一个代理审查', '用证据核查目标'],
    harnesses: [
      ['Claude Code', 'stream-json'],
      ['Codex', 'app-server'],
      ['Kimi Code · OpenCode · Gemini CLI', 'ACP'],
      ['Aider · Amp', '单次运行'],
      ['你自己的运行器', 'ACP'],
    ],
    mailbox: 'troupe mcp · 文件信箱',
    tools: 'ask_agent · ask_user · board · report_progress · goal_status',
    legend: [
      ['task', '派发任务'],
      ['ask', '代理之间提问'],
      ['approve', '等你审批'],
    ],
  },
};

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const W = 1000;
const H = 470;
const LOOP = 9;

// Geometry.
const UI = { x: 20, w: 220, top: 70, h: 54, gap: 14 };
const ENGINE = { x: 330, y: 70, w: 300, h: 260 };
const AGENTS = { x: 690, w: 290, top: 70, h: 44, gap: 10 };
const MAIL = { x: 330, y: 380, w: 650, h: 64 };
const uiBox = (i) => ({ x: UI.x, y: UI.top + i * (UI.h + UI.gap), w: UI.w, h: UI.h });
const agentBox = (i) => ({ x: AGENTS.x, y: AGENTS.top + i * (AGENTS.h + AGENTS.gap), w: AGENTS.w, h: AGENTS.h });
const mid = (box) => box.y + box.h / 2;

// A dot travelling through points between `from` and `to` seconds of the loop.
function trip(id, kind, points, from, to) {
  const pct = (s) => `${((s / LOOP) * 100).toFixed(2)}%`;
  const legs = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  const length = legs.reduce((a, b) => a + b, 0);
  let travelled = 0;
  const stops = [`0%,${pct(from)}{transform:translate(${points[0][0]}px,${points[0][1]}px);opacity:0}`];
  stops.push(`${pct(from + 0.15)}{opacity:1}`);
  points.forEach((p, i) => {
    if (i) travelled += legs[i - 1];
    const at = from + ((to - from) * travelled) / length;
    stops.push(`${pct(at)}{transform:translate(${p[0]}px,${p[1]}px)}`);
  });
  stops.push(`${pct(to)}{opacity:1}`, `${pct(Math.min(LOOP, to + 0.3))}{opacity:0;transform:translate(${points.at(-1)[0]}px,${points.at(-1)[1]}px)}`, '100%{opacity:0}');
  return {
    css: `@keyframes ${id}{${stops.join('')}}`,
    svg: `<circle r="5" class="dot ${kind}" style="animation-name:${id}"/>`,
  };
}

function diagram(lang) {
  const s = TEXT[lang];
  const parts = [];
  const css = [];
  const card = (box, cls = 'card') => `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="10" class="${cls}"/>`;

  // Column titles.
  parts.push(`<text x="${UI.x}" y="50" class="caps">${esc(s.you)}</text>`);
  parts.push(`<text x="${ENGINE.x}" y="50" class="caps">${esc(s.engine)}</text>`);
  parts.push(`<text x="${AGENTS.x}" y="50" class="caps">${esc(s.agents)}</text>`);

  // Interfaces → engine.
  s.ui.forEach(([name, command], i) => {
    const box = uiBox(i);
    parts.push(`<path d="M${box.x + box.w} ${mid(box)}H${ENGINE.x}" class="wire"/>`);
    parts.push(card(box), `<text x="${box.x + 16}" y="${box.y + 23}" class="name">${esc(name)}</text>`, `<text x="${box.x + 16}" y="${box.y + 42}" class="mono">${esc(command)}</text>`);
  });
  parts.push(`<text x="${(UI.x + UI.w + ENGINE.x) / 2}" y="${UI.top + 4 * (UI.h + UI.gap) + 12}" text-anchor="middle" class="note">${esc(s.client)}</text>`);

  // The engine.
  parts.push(card(ENGINE, 'engine'), `<text x="${ENGINE.x + 20}" y="${ENGINE.y + 34}" class="title">${esc(s.title)}</text>`, `<text x="${ENGINE.x + ENGINE.w - 20}" y="${ENGINE.y + 34}" text-anchor="end" class="mono accent">${esc(s.protocol)}</text>`);
  s.parts.forEach((part, i) => {
    const y = ENGINE.y + 56 + i * 38;
    parts.push(`<rect x="${ENGINE.x + 20}" y="${y}" width="${ENGINE.w - 40}" height="30" rx="15" class="pill"/>`, `<text x="${ENGINE.x + 36}" y="${y + 20}" class="pilltext">${esc(part)}</text>`);
  });

  // Engine → agents, each through its protocol; agents → mailbox.
  s.harnesses.forEach(([name, protocol], i) => {
    const box = agentBox(i);
    const own = i === s.harnesses.length - 1;
    parts.push(`<path d="M${ENGINE.x + ENGINE.w} ${mid(box)}H${box.x}" class="wire"/>`);
    parts.push(card(box, own ? 'card own' : 'card'), `<text x="${box.x + 14}" y="${box.y + 27}" class="name small">${esc(name)}</text>`);
    parts.push(`<text x="${box.x + box.w - 14}" y="${box.y + 27}" text-anchor="end" class="mono tag">${esc(protocol)}</text>`);
  });
  const lastAgent = agentBox(s.harnesses.length - 1);
  parts.push(`<path d="M${AGENTS.x + AGENTS.w / 2} ${lastAgent.y + lastAgent.h}V${MAIL.y}" class="wire dashed"/>`);
  parts.push(`<path d="M${ENGINE.x + ENGINE.w / 2} ${ENGINE.y + ENGINE.h}V${MAIL.y}" class="wire dashed"/>`);

  // The mailbox.
  parts.push(`<rect x="${MAIL.x}" y="${MAIL.y}" width="${MAIL.w}" height="${MAIL.h}" rx="10" class="mail"/>`);
  parts.push(`<text x="${MAIL.x + 20}" y="${MAIL.y + 27}" class="name mailtext">${esc(s.mailbox)}</text>`, `<text x="${MAIL.x + 20}" y="${MAIL.y + 48}" class="mono mailtext">${esc(s.tools)}</text>`);

  // Legend.
  s.legend.forEach(([kind, text], i) => {
    const x = UI.x + 4;
    const y = MAIL.y + 8 + i * 22;
    parts.push(`<circle cx="${x + 5}" cy="${y}" r="5" class="dot ${kind}" style="opacity:1;animation:none"/>`, `<text x="${x + 18}" y="${y + 4.5}" class="note left">${esc(text)}</text>`);
  });

  // Moving dots: a task out to three agents, a question from Claude to Codex through
  // the mailbox and the engine, and an approval from Claude back to you.
  const engineIn = ENGINE.x;
  const engineOut = ENGINE.x + ENGINE.w;
  const ui0 = uiBox(0);
  const trips = [
    trip('t1', 'task', [[ui0.x + ui0.w, mid(ui0)], [engineIn, mid(ui0)], [engineOut, mid(agentBox(0))], [AGENTS.x, mid(agentBox(0))]], 0.2, 1.7),
    trip('t2', 'task', [[ui0.x + ui0.w, mid(ui0)], [engineIn, mid(ui0)], [engineOut, mid(agentBox(1))], [AGENTS.x, mid(agentBox(1))]], 0.2, 1.8),
    trip('t3', 'task', [[ui0.x + ui0.w, mid(ui0)], [engineIn, mid(ui0)], [engineOut, mid(agentBox(2))], [AGENTS.x, mid(agentBox(2))]], 0.2, 1.9),
    trip('q1', 'ask', [[AGENTS.x + AGENTS.w / 2, lastAgent.y + lastAgent.h], [AGENTS.x + AGENTS.w / 2, MAIL.y], [ENGINE.x + ENGINE.w / 2, MAIL.y], [ENGINE.x + ENGINE.w / 2, ENGINE.y + ENGINE.h], [engineOut, mid(agentBox(1))], [AGENTS.x, mid(agentBox(1))]], 2.6, 5.2),
    trip('a1', 'approve', [[AGENTS.x, mid(agentBox(0))], [engineOut, mid(agentBox(0))], [engineIn, mid(ui0)], [ui0.x + ui0.w, mid(ui0)]], 5.8, 7.3),
  ];
  for (const t of trips) {
    css.push(t.css);
    parts.push(t.svg);
  }

  const sans = 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",Helvetica,Arial,sans-serif';
  const mono = 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(s.label)}">`,
    `<title>${esc(s.label)}</title>`,
    '<style>',
    `text{font-family:${sans};fill:#1f2328}.mono{font-family:${mono};font-size:12.5px;fill:#656d76}`,
    '.caps{font-size:11.5px;font-weight:700;letter-spacing:.8px;fill:#656d76}.name{font-size:15px;font-weight:600}.small{font-size:13.5px}.title{font-size:18px;font-weight:700}.note{font-size:12px;fill:#656d76}.left{text-anchor:start}',
    '.card{fill:#ffffff;stroke:#d0d7de}.own{stroke-dasharray:5 4}.engine{fill:#f6f8fa;stroke:#2f81f7;stroke-width:1.5}.pill{fill:#ddf4ff}.pilltext{font-size:13.5px;fill:#0969da}.accent{fill:#0969da}.tag{fill:#8250df}',
    '.mail{fill:#fff8c5;stroke:#d4a72c}.mailtext{fill:#7d4e00}.wire{fill:none;stroke:#afb8c1;stroke-width:1.5}.dashed{stroke-dasharray:4 4}',
    `.dot{opacity:0;animation-duration:${LOOP}s;animation-iteration-count:infinite;animation-timing-function:linear}.task{fill:#2f81f7}.ask{fill:#8250df}.approve{fill:#bf8700}`,
    '@media (prefers-reduced-motion:reduce){.dot{animation:none}}',
    '@media (prefers-color-scheme:dark){text{fill:#e6edf3}.mono,.caps,.note{fill:#8b949e}.card{fill:#161b22;stroke:#30363d}.engine{fill:#0d1117;stroke:#2f81f7}.pill{fill:#12263b}.pilltext,.accent{fill:#58a6ff}.tag{fill:#bc8cff}.mail{fill:#2b2111;stroke:#9e6a03}.mailtext{fill:#e3b341}.wire{stroke:#484f58}.task{fill:#58a6ff}.ask{fill:#bc8cff}.approve{fill:#d29922}}',
    ...css,
    '</style>',
    ...parts,
    '</svg>',
  ].join('\n');
}

fs.mkdirSync(out, { recursive: true });
for (const lang of Object.keys(TEXT)) {
  const file = path.join(out, lang === 'en' ? 'how-it-works.svg' : `how-it-works.${lang}.svg`);
  fs.writeFileSync(file, diagram(lang) + '\n');
  console.log(path.relative(ROOT, file));
}
