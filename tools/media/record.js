#!/usr/bin/env node
// Records the animations in the README from Troupe's real interfaces.
//
//   node tools/media/record.js [--lang en|zh] [--out docs/media] [--only terminal|web]
//
// The web UI is recorded with a Playwright installation of your own:
//   TROUPE_PLAYWRIGHT=/path/to/node_modules/playwright/index.js (TROUPE_CHROME optional)
//
// The engine, the terminal UI, worktrees, approvals, reviews and merges are all real;
// the agents are stand-ins (standins/) that speak the BizOS CLI (`bizos acp`), Claude
// Code, Codex and ACP protocols and act out story.js, editing files and running the
// tests for real.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localClient } from '../../src/engine/rpc.js';
import { translate } from '../../src/i18n/strings.js';
import { stage } from './stage.js';
import { text } from './story.js';
import { clip, terminalSvg } from './svg-terminal.js';
import { webSvg } from './svg-web.js';
import { recordTui, sleep } from './tui.js';
import { recordWeb } from './web.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const lang = option('--lang', 'en');
const out = path.resolve(ROOT, option('--out', 'docs/media'));
const only = option('--only', null);
const suffix = lang === 'en' ? '' : `.${lang}`;

const LABELS = {
  en: {
    dispatch: 'One message, three agents',
    approve: 'You approve in one place',
    collaborate: 'Agents ask each other',
    done: 'Each on its own branch',
    diff: 'See what changed',
    review: 'Another agent reviews',
    merge: 'Merge',
    title: 'troupe — shop-api',
    hero: 'Troupe terminal UI: one message starts BizOS CLI (BizOS Code), Codex and Claude Code in parallel; you allow a command for BizOS once and for all, Codex asks BizOS a question, and each agent finishes on its own branch.',
    reviewMerge: "Troupe terminal UI: the diff of BizOS CLI's branch, a review by Codex, then the merge.",
    web: 'Troupe web UI: the same message from the browser, an approval card for BizOS CLI, then a review by another agent and the merge.',
  },
  zh: {
    dispatch: '一条消息，三个代理',
    approve: '在一处审批',
    collaborate: '代理之间互相提问',
    done: '各自在独立分支完成',
    diff: '查看改动',
    review: '另一个代理审查',
    merge: '合并',
    title: 'troupe — shop-api',
    hero: 'Troupe 终端界面：一条消息同时启动 BizOS CLI（BizOS Code）、Codex 和 Claude Code；你为 BizOS 的命令选择“以后都允许”，Codex 向 BizOS 提问，每个代理在自己的分支上完成工作。',
    reviewMerge: 'Troupe 终端界面：查看 BizOS CLI 分支的改动，由 Codex 审查，然后合并。',
    web: 'Troupe 网页界面：在浏览器里发出同一条消息，处理 BizOS CLI 的审批卡片，再由另一个代理审查后合并。',
  },
}[lang];

async function until(check, label, timeoutMs = 90_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(25);
  }
}

async function recordTerminal() {
  process.env.DEMO_PACE = '1.6';
  const { engine } = await stage({ lang });
  const client = localClient(engine);
  await client.call('providers', {});
  const tui = recordTui({ client, lang });
  const story = text(lang);
  const agents = () => [...engine.agents.values()];
  const named = (name) => agents().find((agent) => agent.name === name);
  const idle = () => agents().length > 0 && agents().every((agent) => !agent.busy);
  let merged = false;
  client.subscribe((event) => {
    if (event.type === 'merge.result' && event.ok) merged = true;
  });

  // Hero: one message to three agents, a command allowed for good, a question between
  // agents, three finished branches.
  await sleep(1300);
  tui.mark('dispatch');
  for (const [i, line] of story.message.entries()) {
    if (i) tui.press('\x1b\r');
    // The first mention waits on the completion list for a moment.
    if (i === 0) {
      await tui.type('@');
      await sleep(900);
      await tui.type(line.slice(1));
    } else await tui.type(line);
  }
  await sleep(800);
  tui.press('\r');
  await until(() => engine.approvals.size > 0, 'an approval');
  tui.mark('approve');
  await sleep(2400);
  // "Always allow this for @bizos": its second test run is not asked about.
  tui.press('2');
  await until(() => named('bizos')?.current?.input?.kind === 'question', 'the question to @bizos');
  tui.mark('collaborate');
  await until(idle, 'every agent to finish');
  await sleep(1000);
  tui.mark('done');
  tui.press('\x1b');
  await sleep(700);
  tui.press('2');
  await sleep(4200);
  tui.mark('hero-end');

  // Review and merge @bizos's branch; Codex reviews it.
  tui.press('1');
  await sleep(1400);
  tui.mark('diff');
  tui.press('d');
  await sleep(4200);
  tui.press('m');
  await sleep(1500);
  tui.mark('review');
  tui.press('\r');
  await until(() => named('codex')?.current?.input?.kind === 'review', 'the review to start');
  await until(() => !named('codex').busy, 'the review');
  await sleep(3600);
  tui.mark('merge');
  tui.press('\r');
  await until(() => merged, 'the merge');
  await sleep(3600);
  tui.mark('merge-end');

  await tui.stop();
  await engine.close();
  return tui;
}

async function recordBrowser(playwright) {
  process.env.DEMO_PACE = '1.25';
  const { engine } = await stage({ lang });
  const client = localClient(engine);
  await client.call('providers', {});
  const web = await recordWeb({ client, lang, playwright, chrome: process.env.TROUPE_CHROME || null });
  const story = text(lang);
  const named = (name) => [...engine.agents.values()].find((agent) => agent.name === name);
  const idle = () => engine.agents.size > 0 && [...engine.agents.values()].every((agent) => !agent.busy);
  let merged = false;
  client.subscribe((event) => {
    if (event.type === 'merge.result' && event.ok) merged = true;
  });

  await web.open();
  await sleep(1000);
  await web.click('#input', { dx: 0.25 });
  await web.type(story.message.join('\n'));
  await sleep(500);
  await web.click('#send');
  await until(() => engine.approvals.size > 0, 'an approval');
  await sleep(1600);
  // "Always allow this for @bizos".
  await web.click('#waiting .card button.ok');
  await until(idle, 'every agent to finish');
  await sleep(1000);
  await web.click(`#agent-head button:text-is("${translate(lang, 'gui.merge')}")`);
  await sleep(1200);
  await web.click('dialog .dialog-actions button.primary');
  await until(() => named('codex')?.current?.input?.kind === 'review', 'the review to start');
  await until(() => !named('codex').busy, 'the review');
  await sleep(2200);
  await web.click('dialog .dialog-actions button.primary');
  await until(() => merged, 'the merge');
  await sleep(2600);
  const end = await web.stop();
  await engine.close();
  return { ...web, end };
}

function chapters(marks, names, start, end) {
  const at = (name) => marks.find((mark) => mark.name === name).t - start;
  return names.map((name, i) => ({ label: LABELS[name], start: i ? at(name) : 0, end: i + 1 < names.length ? at(names[i + 1]) : end - start }));
}

fs.mkdirSync(out, { recursive: true });
const report = (file, svg, extra) => {
  fs.writeFileSync(path.join(out, file), svg + '\n');
  console.log(`${file}: ${extra}, ${(svg.length / 1024).toFixed(0)} KB`);
};

if (only !== 'web') {
  const tape = await recordTerminal();
  const t = (name) => tape.marks.find((mark) => mark.name === name).t;
  const scenes = [
    { file: `hero${suffix}.svg`, from: 0, to: t('hero-end'), names: ['dispatch', 'approve', 'collaborate', 'done'], label: LABELS.hero },
    { file: `review-merge${suffix}.svg`, from: t('hero-end'), to: t('merge-end'), names: ['diff', 'review', 'merge'], label: LABELS.reviewMerge },
  ];
  for (const scene of scenes) {
    const frames = clip(tape.frames, scene.from, scene.to);
    const svg = terminalSvg(frames, { columns: 112, rows: 30, title: LABELS.title, end: scene.to - scene.from, chapters: chapters(tape.marks, scene.names, scene.from, scene.to), label: scene.label });
    report(scene.file, svg, `${frames.length} frames, ${((scene.to - scene.from) / 1000).toFixed(1)} s`);
  }
}

if (only !== 'terminal') {
  const playwright = process.env.TROUPE_PLAYWRIGHT;
  if (!playwright && only === 'web') throw new Error('Set TROUPE_PLAYWRIGHT to the index.js of a Playwright installation to record the web UI');
  if (!playwright) console.log(`web${suffix}.svg: skipped (set TROUPE_PLAYWRIGHT to record the web UI)`);
  else {
    const web = await recordBrowser(playwright);
    const svg = webSvg(web.frames, { end: web.end, width: 1080, height: 660, pointer: web.pointer, clicks: web.clicks, url: '127.0.0.1:7788', label: LABELS.web });
    report(`web${suffix}.svg`, svg, `${web.frames.length} frames, ${(web.end / 1000).toFixed(1)} s`);
  }
}
