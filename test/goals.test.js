import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { approveGoal, armProblems, goalBrief, normalizeGoal, parseGoalDraft } from '../src/goals/goal.js';
import { evaluateGate, feedbackPrompt, parseVerdict, reviewPrompt, runCheck } from '../src/goals/gate.js';
import { CODES } from '../src/protocol/errors.js';
import { tempDir } from './helpers.js';

const draft = {
  title: 'Fix the parser',
  outcome: 'Invalid input reports the line number',
  criteria: [
    { id: 'tests', text: 'the test suite passes', check: { run: 'exit 0' } },
    { id: 'review', text: 'errors are readable', review: { by: '@codex' } },
  ],
  boundaries: ['keep the public API'],
  questions: [{ id: 'q1', text: 'Support Node 18?' }],
  assignees: ['@claude'],
};

test('a goal arms only when complete, independent, answered and approved', () => {
  let goal = normalizeGoal(draft);
  assert.equal(goal.revision, 1);
  assert.deepEqual(goal.assignees, ['claude']);
  assert.equal(goal.criteria[1].review.by, 'codex');
  assert.deepEqual(
    armProblems(goal).map((p) => p.code),
    ['questions', 'approval'],
  );
  assert.throws(() => approveGoal(goal), (error) => error.code === CODES.GATE_NOT_ARMED);
  goal = normalizeGoal({ ...draft, questions: [{ id: 'q1', text: 'Support Node 18?', answer: 'no' }] }, goal);
  assert.equal(goal.revision, 2);
  goal = approveGoal(goal);
  assert.equal(goal.approvedRevision, 2);
  assert.deepEqual(armProblems(goal), []);
  // Saving the same content keeps the approval; changing a criterion needs a new one.
  const same = normalizeGoal({ ...draft, questions: [{ id: 'q1', text: 'Support Node 18?', answer: 'no' }] }, goal);
  assert.equal(same.approvedRevision, 2);
  const changed = normalizeGoal({ ...draft, criteria: [draft.criteria[0]], questions: [{ id: 'q1', text: 'Support Node 18?', answer: 'no' }] }, goal);
  assert.equal(changed.revision, 3);
  assert.equal(changed.approvedRevision, null);
  assert.equal(changed.status, 'draft');
});

test('a reviewer cannot also be an assignee, and some criterion must be independent', () => {
  const goal = normalizeGoal({ ...draft, questions: [], assignees: ['codex'] });
  assert.ok(armProblems(goal).some((p) => p.code === 'reviewer'));
  const selfReported = normalizeGoal({ title: 't', outcome: 'o', criteria: [{ text: 'looks good' }], assignees: ['claude'] });
  assert.ok(armProblems(selfReported).some((p) => p.code === 'independent'));
  assert.throws(() => normalizeGoal({ title: 't', criteria: [{ id: 'x', text: 'a' }, { id: 'x', text: 'b' }] }), (error) => error.code === CODES.GOAL_INVALID);
});

test('command checks run in the worktree and record evidence', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'marker.txt'), 'ok\n');
  const pass = await runCheck({ id: 'a', check: { run: 'cat marker.txt && echo all good' } }, { cwd: dir });
  assert.equal(pass.passed, true);
  assert.match(pass.evidence.outputTail, /all good/);
  const fail = await runCheck({ id: 'b', check: { run: 'echo broken >&2; exit 3' } }, { cwd: dir });
  assert.equal(fail.passed, false);
  assert.match(fail.summary, /exit 3, expected 0: broken/);
  const output = await runCheck({ id: 'c', check: { run: 'echo version 2', expect: { output: 'version 3' } } }, { cwd: dir });
  assert.equal(output.passed, false);
  assert.match(output.summary, /did not match/);
  const slow = await runCheck({ id: 'd', check: { run: 'sleep 5', timeoutSec: 0.3 } }, { cwd: dir });
  assert.equal(slow.passed, false);
  assert.equal(slow.evidence.timedOut, true);
});

test('the gate combines checks and reviews and writes feedback for failures', async (t) => {
  const dir = tempDir(t);
  const goal = approveGoal(normalizeGoal({ ...draft, questions: [], criteria: [...draft.criteria, { id: 'manual', text: 'demo approved by PM' }] }));
  const reviewed = [];
  const gate = await evaluateGate({
    goal,
    agentName: 'claude',
    cwd: dir,
    projectRoot: dir,
    iteration: 1,
    review: async (criterion) => {
      reviewed.push(criterion.id);
      return { passed: false, summary: 'reviewer: messages lack context' };
    },
  });
  assert.deepEqual(reviewed, ['review']);
  assert.equal(gate.passed, false);
  assert.deepEqual(
    gate.criteria.map((c) => [c.id, c.passed]),
    [
      ['tests', true],
      ['review', false],
      ['manual', false],
    ],
  );
  const feedback = feedbackPrompt(goal, gate);
  assert.match(feedback, /iteration 1 of 5/);
  assert.match(feedback, /review: errors are readable → reviewer: messages lack context/);
  assert.doesNotMatch(feedback, /- tests/);
});

test('verdicts and goal drafts are parsed from agent replies', () => {
  assert.deepEqual(parseVerdict('Looks fine.\nVERDICT: PASS'), { passed: true, summary: 'reviewer: pass' });
  assert.equal(parseVerdict('VERDICT: PASS\nwait...\nVERDICT: FAIL — tests missing').passed, false);
  assert.equal(parseVerdict('no verdict here').passed, false);
  const parsed = parseGoalDraft('Here you go:\n```json\n{"title":"T","outcome":"O","criteria":[{"text":"x","check":{"run":"true"}}]}\n```');
  assert.equal(parsed.title, 'T');
  assert.throws(() => parseGoalDraft('nothing useful'), (error) => error.code === CODES.GOAL_INVALID);
  const goal = normalizeGoal(draft);
  assert.match(goalBrief(goal), /checked by running: exit 0/);
  assert.match(reviewPrompt({ goal, criterion: goal.criteria[1], author: 'claude', diff: '+x' }), /VERDICT: PASS/);
});

test('a check does not leave processes behind', { skip: process.platform === 'win32' ? 'process groups are POSIX' : false }, async (t) => {
  const dir = tempDir(t);
  const result = await runCheck({ id: 'bg', check: { run: 'sleep 30 > /dev/null 2>&1 & echo $!' } }, { cwd: dir });
  assert.equal(result.passed, true);
  const pid = Number(result.evidence.outputTail.trim());
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(alive(), false, 'the background sleep was stopped with its group');
});
