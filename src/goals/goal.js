// Goals (spec/goals.md): what "done" means, written down before work starts and
// checked by Troupe itself rather than by the agent that did the work.
import { randomUUID } from 'node:crypto';
import { CODES, fail } from '../protocol/errors.js';

export const GOAL_SCHEMA = 'troupe.goal/1';
export const GOAL_STATUS = Object.freeze(['draft', 'approved', 'running', 'met', 'needs-you', 'failed']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const MAX_TEXT = 4000;
const MAX_CRITERIA = 30;

const text = (value, max = MAX_TEXT) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const agentName = (value) => text(value, 64).replace(/^@/, '');

function normalizeCriterion(raw, index) {
  const id = ID.test(raw?.id || '') ? raw.id : `c${index + 1}`;
  const criterion = { id, text: text(raw?.text) };
  if (raw?.check && typeof raw.check === 'object' && text(raw.check.run, 2000)) {
    criterion.check = { run: text(raw.check.run, 2000) };
    if (['worktree', 'project'].includes(raw.check.cwd)) criterion.check.cwd = raw.check.cwd;
    if (Number.isFinite(raw.check.timeoutSec) && raw.check.timeoutSec > 0) criterion.check.timeoutSec = Math.min(raw.check.timeoutSec, 3600);
    const expect = raw.check.expect && typeof raw.check.expect === 'object' ? raw.check.expect : {};
    const normalizedExpect = {};
    if (Number.isInteger(expect.exitCode)) normalizedExpect.exitCode = expect.exitCode;
    if (typeof expect.output === 'string' && expect.output) {
      try {
        new RegExp(expect.output);
        normalizedExpect.output = expect.output.slice(0, 500);
      } catch {
        throw fail(CODES.GOAL_INVALID, `Criterion ${id}: expect.output is not a valid regular expression`);
      }
    }
    if (Object.keys(normalizedExpect).length) criterion.check.expect = normalizedExpect;
  } else if (raw?.review && typeof raw.review === 'object' && agentName(raw.review.by)) {
    criterion.review = { by: agentName(raw.review.by) };
  }
  return criterion;
}

/** A clean goal document from user or agent input. Throws GOAL_INVALID on bad shapes. */
export function normalizeGoal(input, previous = null) {
  if (!input || typeof input !== 'object') throw fail(CODES.GOAL_INVALID, 'A goal must be an object');
  const criteria = (Array.isArray(input.criteria) ? input.criteria : []).slice(0, MAX_CRITERIA).map(normalizeCriterion);
  const ids = new Set();
  for (const criterion of criteria) {
    if (ids.has(criterion.id)) throw fail(CODES.GOAL_INVALID, `Duplicate criterion id: ${criterion.id}`);
    ids.add(criterion.id);
  }
  const questions = (Array.isArray(input.questions) ? input.questions : [])
    .slice(0, 20)
    .map((q, i) => ({ id: ID.test(q?.id || '') ? q.id : `q${i + 1}`, text: text(q?.text, 1000), answer: typeof q?.answer === 'string' && q.answer.trim() ? q.answer.trim().slice(0, 2000) : null }))
    .filter((q) => q.text);
  const now = new Date().toISOString();
  const goal = {
    schema: GOAL_SCHEMA,
    id: previous?.id || (ID.test(input.id || '') ? input.id : `goal-${randomUUID().slice(0, 8)}`),
    title: text(input.title, 200),
    outcome: text(input.outcome),
    criteria,
    boundaries: (Array.isArray(input.boundaries) ? input.boundaries : []).map((b) => text(b, 500)).filter(Boolean).slice(0, 20),
    questions,
    assignees: [...new Set((Array.isArray(input.assignees) ? input.assignees : []).map(agentName).filter(Boolean))].slice(0, 10),
    maxIterations: Number.isInteger(input.maxIterations) && input.maxIterations > 0 ? Math.min(input.maxIterations, 20) : previous?.maxIterations || 5,
    status: previous?.status || 'draft',
    revision: previous?.revision || 1,
    approvedRevision: previous?.approvedRevision ?? null,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    gates: previous?.gates || [],
    // The user's confirmations of manual criteria; kept apart so they are not edits.
    confirmations: { ...(previous?.confirmations || {}) },
  };
  for (const id of Object.keys(goal.confirmations)) if (!criteria.some((c) => c.id === id && !c.check && !c.review)) delete goal.confirmations[id];
  // Any change to what "done" means is a new revision and needs a fresh approval.
  if (previous && contentKey(goal) !== contentKey(previous)) {
    goal.revision = previous.revision + 1;
    goal.approvedRevision = null;
    goal.status = 'draft';
  }
  return goal;
}

const contentKey = (goal) => JSON.stringify([goal.title, goal.outcome, goal.criteria, goal.boundaries, goal.questions, goal.assignees, goal.maxIterations]);

/**
 * What stops a goal from being armed. Empty means it may run.
 * Mirrors the review/start gates: a stated outcome, at least one independently
 * checkable criterion, reviewers who are not the assignees, no open questions,
 * and the user's approval of this exact revision.
 * @returns {{code:string, message:string}[]}
 */
export function armProblems(goal) {
  const problems = [];
  if (!goal.title) problems.push({ code: 'title', message: 'Give the goal a title' });
  if (!goal.outcome) problems.push({ code: 'outcome', message: 'State the outcome in one or two sentences' });
  if (!goal.criteria.length) problems.push({ code: 'criteria', message: 'Add at least one acceptance criterion' });
  for (const c of goal.criteria) if (!c.text) problems.push({ code: 'criterion-text', message: `Criterion ${c.id} needs a description` });
  if (goal.criteria.length && !goal.criteria.some((c) => c.check || c.review)) {
    problems.push({ code: 'independent', message: 'At least one criterion must be checked independently: a command Troupe runs, or a review by another agent' });
  }
  for (const c of goal.criteria) {
    if (c.review && goal.assignees.includes(c.review.by)) problems.push({ code: 'reviewer', message: `Criterion ${c.id} is reviewed by @${c.review.by}, who is also doing the work` });
  }
  if (!goal.assignees.length) problems.push({ code: 'assignees', message: 'Assign the goal to at least one agent' });
  const open = goal.questions.filter((q) => !q.answer);
  if (open.length) problems.push({ code: 'questions', message: `Answer the open question${open.length > 1 ? 's' : ''} first: ${open.map((q) => q.text).join(' / ')}` });
  if (goal.approvedRevision !== goal.revision) problems.push({ code: 'approval', message: 'Approve this revision of the goal' });
  return problems;
}

/** Marks the current revision approved once nothing but the approval is missing. */
export function approveGoal(goal) {
  const problems = armProblems({ ...goal, approvedRevision: goal.revision });
  if (problems.length) throw fail(CODES.GATE_NOT_ARMED, problems.map((p) => p.message).join('; '), { problems });
  return { ...goal, approvedRevision: goal.revision, status: goal.status === 'met' ? 'met' : 'approved', updatedAt: new Date().toISOString() };
}

/** A goal as the prompt that starts an assignee's work. */
export function goalBrief(goal) {
  const lines = [
    `Goal: ${goal.title}`,
    `Outcome: ${goal.outcome}`,
    'Acceptance criteria (Troupe checks these itself when your turn ends):',
    ...goal.criteria.map((c) => `- ${c.id}: ${c.text}${c.check ? ` [checked by running: ${c.check.run}]` : c.review ? ` [reviewed by @${c.review.by}]` : ' [confirmed by the user]'}`),
  ];
  if (goal.boundaries.length) lines.push('Boundaries:', ...goal.boundaries.map((b) => `- ${b}`));
  const answered = goal.questions.filter((q) => q.answer);
  if (answered.length) lines.push('Decisions already made:', ...answered.map((q) => `- ${q.text} → ${q.answer}`));
  lines.push('Work until every criterion holds. Use troupe_goal_status to see the latest check results.');
  return lines.join('\n');
}

/** The JSON shape agents are asked to produce when drafting a goal. */
export const DRAFT_INSTRUCTIONS = `Reply with only a JSON object of this shape (no prose around it):
{"title": "...", "outcome": "one or two sentences",
 "criteria": [{"id": "tests", "text": "what must be true", "check": {"run": "shell command that exits 0 when it holds"}},
              {"id": "review", "text": "what a reviewer must confirm", "review": {"by": "AGENT"}}],
 "boundaries": ["what must not change"],
 "questions": [{"id": "q1", "text": "a decision only the user can make"}]}
Prefer checks a command can verify. Use review criteria for what a command cannot see. List open questions instead of guessing.`;

/** Parses a JSON goal out of an agent's reply (tolerates code fences and prose). */
export function parseGoalDraft(reply) {
  const textValue = String(reply || '');
  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  for (const match of textValue.matchAll(fence)) candidates.push(match[1]);
  const first = textValue.indexOf('{');
  const last = textValue.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(textValue.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && (value.outcome || value.criteria)) return value;
    } catch {
      /* Try the next candidate. */
    }
  }
  throw fail(CODES.GOAL_INVALID, 'The reply did not contain a goal in JSON');
}
