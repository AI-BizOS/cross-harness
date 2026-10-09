// The collaboration tools every agent gets (spec/collaboration.md). Names, inputs and
// semantics are part of troupe/1; the reply wording is guidance for the model.
import { LIMITS } from '../protocol/index.js';

export const SERVER_NAME = 'troupe';
export const BOARD_KEY_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$';

export const INSTRUCTIONS = [
  'You are one of several coding agents working on the same project under Troupe.',
  'Call troupe_list_agents and troupe_board_read before changing code another agent may own.',
  'When you need something another agent owns (its task, files, branch or interfaces), ask it with troupe_ask_agent instead of guessing.',
  'Ask the user with troupe_ask_user only for decisions you cannot make yourself.',
  'Record plans, interface contracts and file ownership with troupe_board_write, and post a one-line status with troupe_report_progress when you start or finish a step.',
  'If a goal is set, troupe_goal_status lists its acceptance criteria; Troupe checks them itself when your turn ends, so make them pass rather than claiming they do.',
  'If an ask stops waiting, keep working and collect the reply later with troupe_check_answers.',
].join(' ');

const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const string = (description, maxLength, extra = {}) => ({ type: 'string', description, minLength: 1, maxLength, ...extra });
const wait = (fallback) => ({ type: 'number', minimum: 0, maximum: LIMITS.waitSeconds, default: fallback, description: `Seconds to wait for the reply (default ${fallback}, max ${LIMITS.waitSeconds}).` });

export const TOOLS = [
  {
    name: 'troupe_list_agents',
    op: 'list_agents',
    wait: 0,
    description: 'List the other agents working on this project: their name, harness, state, branch and what each is doing now.',
    inputSchema: object({}),
  },
  {
    name: 'troupe_ask_agent',
    op: 'ask_agent',
    wait: 600,
    description:
      'Ask another agent on this project a question and wait for its answer. Use it for anything that agent owns (its task, files, branch, interfaces) instead of guessing, and make the question self-contained. If no answer arrives in time you get a question id; collect the answer later with troupe_check_answers.',
    inputSchema: object(
      {
        agent: string('Agent name (as shown by troupe_list_agents), id prefix, or harness id.', 200),
        question: string('The question, with the context the other agent needs to answer it.', LIMITS.question),
        wait_seconds: wait(600),
      },
      ['agent', 'question'],
    ),
  },
  {
    name: 'troupe_check_answers',
    op: 'check_answers',
    wait: 0,
    description: 'Collect answers to earlier troupe_ask_agent and troupe_ask_user questions that arrived after the call stopped waiting. Each answer is returned once.',
    inputSchema: object({}),
  },
  {
    name: 'troupe_ask_user',
    op: 'ask_user',
    wait: 1800,
    description:
      'Ask the user to decide something you cannot decide yourself: unclear requirements, a trade-off between valid designs, or a risky or irreversible action. Offer up to 6 short options when the choice is clear-cut. Waits for the reply; if none arrives in time, continue with independent work and call troupe_check_answers later.',
    inputSchema: object(
      {
        question: string('The decision needed, with enough context to answer without reading your session.', LIMITS.question),
        options: { type: 'array', items: string('A possible answer.', 200), maxItems: LIMITS.options, description: 'Optional choices to offer (max 6).' },
        wait_seconds: wait(1800),
      },
      ['question'],
    ),
  },
  {
    name: 'troupe_board_read',
    op: 'board_read',
    wait: 0,
    description: 'Read the project board shared by all agents. Without a key, list every entry with author, time and a preview; with a key, return that entry in full.',
    inputSchema: object({ key: string('Entry key.', 64, { pattern: BOARD_KEY_PATTERN }) }),
  },
  {
    name: 'troupe_board_write',
    op: 'board_write',
    wait: 0,
    description:
      'Write an entry on the shared project board: the plan, an interface contract, who owns which files, or a decision others must follow. Writing a key replaces it; an empty value deletes it.',
    inputSchema: object(
      {
        key: string('Short key such as plan, api.orders or owner:src/ui.', 64, { pattern: BOARD_KEY_PATTERN }),
        value: { type: 'string', maxLength: LIMITS.boardValue, description: `Entry text (max ${LIMITS.boardValue} characters); empty deletes the entry.` },
      },
      ['key', 'value'],
    ),
  },
  {
    name: 'troupe_report_progress',
    op: 'report_progress',
    wait: 0,
    description: 'Tell the user and the other agents in one short line what you are doing now (max 200 characters). Call it when you start or finish a step.',
    inputSchema: object({ status: string('One-line status.', LIMITS.status) }, ['status']),
  },
  {
    name: 'troupe_goal_status',
    op: 'goal_status',
    wait: 0,
    description: 'Show the goal assigned to you: its outcome, acceptance criteria, boundaries and the latest results of the checks Troupe runs on your work.',
    inputSchema: object({}),
  },
];

export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]));

const short = (value, max = 80) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
};
const LATER = 'Continue with work that does not depend on it and collect the answer later with troupe_check_answers.';

/** Turns a hub result into the text the model sees. */
export const FORMAT = {
  list_agents: (r) =>
    r.agents.length
      ? r.agents.map((a) => `- @${a.name} (${a.provider}, id ${a.id8}): ${a.state}${a.branch ? `, branch ${a.branch}` : ''}${a.doing ? ` — ${a.doing}` : ''}`).join('\n')
      : 'No other agents are working on this project right now.',
  ask_agent: (r) =>
    r.status === 'answered'
      ? `@${r.from} answered:\n${r.answer}`
      : r.status === 'failed'
        ? `@${r.from} could not answer: ${r.error}`
        : r.reason === 'mutual-wait'
          ? `@${r.from} is itself waiting for your answer, so your question (id ${r.questionId}) was delivered without waiting. Finish your current step; collect their reply later with troupe_check_answers.`
          : `No answer from @${r.from} yet (question ${r.questionId}). ${LATER}`,
  check_answers: (r) => {
    const lines = r.answers.map((a) =>
      a.type === 'user'
        ? `The user answered "${short(a.question)}":\n${a.answer}`
        : a.status === 'answered'
          ? `@${a.from} answered "${short(a.question)}":\n${a.answer}`
          : `@${a.from} could not answer "${short(a.question)}": ${a.error}`,
    );
    const waiting = [r.waiting.agents && `${r.waiting.agents} question(s) to agents`, r.waiting.user && `${r.waiting.user} question(s) to the user`].filter(Boolean);
    return [lines.length ? lines.join('\n\n') : 'No new answers.', ...(waiting.length ? [`Still waiting: ${waiting.join(', ')}.`] : [])].join('\n\n');
  },
  ask_user: (r) =>
    r.status === 'answered'
      ? `The user answered:\n${r.answer}`
      : r.status === 'cancelled'
        ? 'The user withdrew this question; decide without it or ask differently.'
        : `The user has not answered yet (question ${r.decisionId}). ${LATER}`,
  board_read: (r) =>
    r.entries
      ? r.entries.length
        ? r.entries.map((e) => `- ${e.key} (${e.author}, ${e.at}): ${e.preview}`).join('\n')
        : 'The project board is empty.'
      : r.entry
        ? `${r.entry.key} (by ${r.entry.author}, ${r.entry.at}):\n${r.entry.value}`
        : `No board entry "${r.key}". ${r.keys.length ? `Keys: ${r.keys.join(', ')}` : 'The project board is empty.'}`,
  board_write: (r) => (r.saved ? `Saved "${r.key}" (${r.count} board entries).` : r.deleted ? `Deleted "${r.key}".` : `There was no entry "${r.key}".`),
  report_progress: () => 'Status posted.',
  goal_status: (r) => {
    if (!r.goal) return 'No goal is assigned to you. Work on the task you were given.';
    const g = r.goal;
    const results = new Map((r.lastGate?.criteria || []).map((c) => [c.id, c]));
    const lines = [
      `Goal: ${g.title}`,
      `Outcome: ${g.outcome}`,
      `Status: ${g.status}${r.lastGate ? ` — last check ${r.lastGate.passed ? 'passed' : 'failed'} (iteration ${r.lastGate.iteration})` : ''}`,
      'Acceptance criteria:',
      ...g.criteria.map((c) => {
        const result = results.get(c.id);
        const how = c.check ? `checked by running \`${c.check.run}\`` : c.review ? `reviewed by @${String(c.review.by).replace(/^@/, '')}` : 'confirmed by the user';
        return `- [${result ? (result.passed ? 'pass' : 'FAIL') : ' '}] ${c.id}: ${c.text} (${how})${result && !result.passed && result.summary ? `\n    ${result.summary}` : ''}`;
      }),
    ];
    if (g.boundaries?.length) lines.push('Boundaries:', ...g.boundaries.map((b) => `- ${b}`));
    return lines.join('\n');
  },
};
