import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { STRINGS, engineText, translate } from '../src/i18n/strings.js';
import { ROOT } from './helpers.js';

const zh = (key, params) => translate('zh', key, params);
const en = (key, params) => translate('en', key, params);

test('messages cross-harness writes itself follow the interface language', () => {
  const created = { role: 'system', code: 'created', params: { branch: 'cross-harness/codex' }, text: 'Working on branch cross-harness/codex in its own worktree' };
  assert.equal(engineText(created, zh), '在自己的 worktree 里工作，分支 cross-harness/codex');
  assert.equal(engineText(created, en), created.text);
  const raised = { code: 'mode-raised', key: 'mode-raised.full', params: { harness: 'Amp', mode: 'ask', final: 'full' }, text: 'Amp cannot run in ask mode, so this agent runs in full mode and acts without asking' };
  assert.equal(engineText(raised, zh), 'Amp 不能以“询问”模式运行，所以这个代理以“完全访问”模式运行，不经询问直接执行');
  assert.equal(engineText(raised, en), raised.text);
  assert.equal(engineText({ role: 'review', key: 'review', params: { name: 'bizos' }, text: "Review @bizos's changes before merging" }, zh), '合并前审查 @bizos 的改动');
  // Transcripts saved before messages carried parameters, and messages this version does
  // not know, keep the engine's text.
  assert.equal(engineText({ code: 'created', text: 'Working on branch x in its own worktree' }, zh), 'Working on branch x in its own worktree');
  assert.equal(engineText({ code: 'from-a-newer-engine', params: {}, text: 'new' }, zh), 'new');
  assert.equal(engineText({ role: 'assistant', text: 'an answer' }, zh), 'an answer');
});

test('every message the engine writes has an English and a Chinese wording', () => {
  const source = ['engine.js', 'agent.js'].map((file) => fs.readFileSync(path.join(ROOT, 'src', 'engine', file), 'utf8')).join('\n');
  const named = [...source.matchAll(/(?:code|key|displayKey): '([a-z][a-z.-]*)'/g)].map((m) => m[1]);
  const computed = ['merged.one', 'mode-raised.full', 'mode-raised.agent', 'mode-raised.full.agent'];
  assert.ok(named.includes('created') && named.includes('denied') && named.includes('review'), 'the scan finds the engine messages');
  for (const name of [...named, ...computed]) {
    assert.ok(STRINGS.en[`engine.${name}`], `engine.${name} (en)`);
    assert.ok(STRINGS.zh[`engine.${name}`], `engine.${name} (zh)`);
  }
  for (const key of Object.keys(STRINGS.en).filter((k) => k.startsWith('engine.'))) assert.ok(STRINGS.zh[key], `${key} (zh)`);
});
