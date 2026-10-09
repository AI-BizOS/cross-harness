// The completion gate: Troupe evaluates a goal's criteria on an agent's work. Command
// checks run in the agent's worktree; review criteria go to a different agent; the
// working agent's own report never counts as evidence (spec/goals.md §Evidence).
import { runCommand } from '../util/process.js';
import { clip } from '../util/text.js';

const OUTPUT_TAIL = 3000;
const IS_WINDOWS = process.platform === 'win32';

function shellCommand(command) {
  return IS_WINDOWS ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] } : { file: '/bin/sh', args: ['-c', command] };
}

/** Runs one command criterion and records its evidence. */
export async function runCheck(criterion, { cwd, env = process.env, defaultTimeoutSec = 600, spawnProcess } = {}) {
  const { run, expect = {}, timeoutSec } = criterion.check;
  const { file, args } = shellCommand(run);
  const started = Date.now();
  const result = await runCommand(file, args, { cwd, env, timeoutMs: (timeoutSec || defaultTimeoutSec) * 1000, maxBuffer: 2 * 1024 * 1024, spawnProcess });
  const durationMs = Date.now() - started;
  const output = `${result.stdout}${result.stderr ? (result.stdout ? '\n' : '') + result.stderr : ''}`;
  const wantedCode = Number.isInteger(expect.exitCode) ? expect.exitCode : 0;
  let passed = !result.timedOut && !result.error && result.code === wantedCode;
  let summary = result.timedOut
    ? `timed out after ${timeoutSec || defaultTimeoutSec}s`
    : result.error
      ? `could not run: ${result.error.message}`
      : result.code === wantedCode
        ? `exit ${result.code}`
        : `exit ${result.code ?? result.signal}, expected ${wantedCode}`;
  if (passed && expect.output) {
    const matched = new RegExp(expect.output, 'm').test(output);
    if (!matched) {
      passed = false;
      summary = `output did not match /${expect.output}/`;
    }
  }
  if (!passed) {
    const last = output.trim().split('\n').slice(-4).join(' | ');
    if (last) summary += `: ${clip(last, 300)}`;
  }
  return {
    id: criterion.id,
    passed,
    summary,
    evidence: { kind: 'command', command: run, cwd, exitCode: result.code, signal: result.signal || null, timedOut: Boolean(result.timedOut), durationMs, outputTail: output.slice(-OUTPUT_TAIL) },
  };
}

/** What a reviewing agent is asked. Its reply must end with a verdict line. */
export function reviewPrompt({ goal, criterion, author, diff }) {
  return [
    `You are reviewing work by @${author} for the goal "${goal.title}".`,
    `Outcome wanted: ${goal.outcome}`,
    `Judge only this acceptance criterion: ${criterion.text}`,
    goal.boundaries.length ? `Boundaries the work must respect: ${goal.boundaries.join('; ')}` : '',
    'Do not change any files. Read the diff below (and the code around it if needed).',
    'End your reply with exactly one line: "VERDICT: PASS" or "VERDICT: FAIL — <the main reason>".',
    '',
    diff ? `Diff of the work:\n\`\`\`diff\n${diff}\n\`\`\`` : 'The agent made no file changes.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function parseVerdict(text) {
  // Only a line that starts with the verdict counts, so quoting the instructions does not.
  const matches = [...String(text || '').matchAll(/^[\s>*_`#-]*VERDICT:\s*(PASS|FAIL)\b[\s—–:*_-]*(.*)$/gim)];
  const last = matches.at(-1);
  if (!last) return { passed: false, summary: 'the reviewer gave no verdict' };
  const passed = last[1].toUpperCase() === 'PASS';
  return { passed, summary: passed ? 'reviewer: pass' : `reviewer: ${clip(last[2].trim() || 'fail', 300)}` };
}

/**
 * Evaluates every criterion. `review(criterion)` asks the reviewing agent and returns
 * {passed, summary, evidence}; it is only called for review criteria.
 */
export async function evaluateGate({ goal, agentName, cwd, projectRoot, env, iteration, tree = null, review, defaultTimeoutSec, spawnProcess }) {
  const criteria = [];
  for (const criterion of goal.criteria) {
    if (criterion.check) {
      const dir = criterion.check.cwd === 'project' ? projectRoot : cwd;
      criteria.push(await runCheck(criterion, { cwd: dir, env, defaultTimeoutSec, spawnProcess }));
    } else if (criterion.review) {
      try {
        const verdict = await review(criterion);
        criteria.push({ id: criterion.id, passed: Boolean(verdict.passed), summary: verdict.summary, evidence: { kind: 'review', reviewer: criterion.review.by, ...(verdict.evidence || {}) } });
      } catch (error) {
        criteria.push({ id: criterion.id, passed: false, summary: `review could not run: ${error.message}`, evidence: { kind: 'review', reviewer: criterion.review.by } });
      }
    } else {
      const confirmed = goal.confirmations?.[criterion.id] === true;
      criteria.push({ id: criterion.id, passed: confirmed, summary: confirmed ? 'confirmed by the user' : 'waiting for the user to confirm', evidence: { kind: 'user' } });
    }
  }
  return { iteration, agent: agentName, at: new Date().toISOString(), tree, passed: criteria.every((c) => c.passed), criteria };
}

/** The message sent back to the working agent when the gate fails. */
export function feedbackPrompt(goal, gate) {
  const failing = gate.criteria.filter((c) => !c.passed);
  return [
    `Troupe checked your work against the goal "${goal.title}" (iteration ${gate.iteration} of ${goal.maxIterations}).`,
    `${failing.length} of ${gate.criteria.length} criteria are not met yet:`,
    ...failing.map((c) => {
      const criterion = goal.criteria.find((item) => item.id === c.id);
      const tailText = c.evidence?.outputTail ? `\n  Output (last lines):\n  ${c.evidence.outputTail.trim().split('\n').slice(-15).join('\n  ')}` : '';
      return `- ${c.id}: ${criterion?.text || ''} → ${c.summary}${tailText}`;
    }),
    'Fix these, then end your turn. Troupe will check again.',
  ].join('\n');
}
