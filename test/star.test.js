import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPOSITORY_URL, createStarPrompt, starPromptFor } from '../src/star.js';
import { loadConfig } from '../src/config.js';
import { tempDir } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

test('the star prompt asks after a merge or from the third launch, and stops once answered', (t) => {
  const file = path.join(tempDir(t), 'nested', 'star.json');
  let clock = Date.parse('2026-10-10T00:00:00Z');
  const star = createStarPrompt({ file, now: () => clock });
  assert.equal(star.url, REPOSITORY_URL);
  star.opened();
  star.opened();
  assert.equal(star.due('launch'), false);
  assert.equal(star.due('merged'), true);
  star.opened();
  assert.equal(star.due('launch'), true);
  star.answer('later');
  assert.equal(star.due('merged'), false, 'later waits');
  clock += 15 * DAY;
  assert.equal(star.due('launch'), true, 'later is over after two weeks');
  star.answer('star');
  clock += 365 * DAY;
  assert.equal(star.due('merged'), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).answer, 'star');
  assert.throws(() => star.answer('maybe'), /Unknown answer/);
  // A damaged file starts over instead of failing.
  fs.writeFileSync(file, 'not json');
  assert.equal(star.due('merged'), true);
});

test('the star prompt can be turned off and never runs in CI', (t) => {
  const home = tempDir(t);
  assert.ok(starPromptFor({ home, config: { starPrompt: true }, env: {} }));
  assert.equal(starPromptFor({ home, config: { starPrompt: false }, env: {} }), null);
  assert.equal(starPromptFor({ home, config: {}, env: { TROUPE_NO_STAR_PROMPT: '1' } }), null);
  assert.equal(starPromptFor({ home, config: {}, env: { CI: 'true' } }), null);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ starPrompt: false }));
  assert.equal(loadConfig({ TROUPE_HOME: home }).starPrompt, false);
  fs.writeFileSync(path.join(home, 'config.json'), '{}');
  assert.equal(loadConfig({ TROUPE_HOME: home }).starPrompt, true);
});
