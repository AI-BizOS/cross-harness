// The dispatch grammar (spec/orchestration.md §Dispatch).
//
//   @codex @claude review src/        one task, several agents, started together
//   @backend add the endpoint         a named agent
//   @codex+ start over                a fresh session instead of resuming
//   @all run the tests                every agent on the project (or every available harness)
//   @auto fix the flaky test          Troupe picks (two different harnesses for reviews)
//   @compare / @compare:claude        after all targets answer, one agent compares the answers
//
// Mentions count only at the start of a line. A line that starts with mentions begins
// a new assignment; following lines without mentions belong to it. Unknown names and
// mid-sentence @ signs are plain text.

const MENTION = /^@([A-Za-z0-9][A-Za-z0-9_.-]{0,39})(\+?)(?::([A-Za-z0-9][A-Za-z0-9_.-]{0,39}))?(?=\s|$)/;
export const SPECIAL = Object.freeze(['all', 'auto', 'compare']);

/**
 * @param {string} text
 * @param {(name:string)=>boolean} isKnown names of agents and harnesses
 * @returns {{assignments:{targets:{name:string,fresh:boolean}[], text:string}[], unaddressed:string, compare:{judge:string|null}|null}}
 */
export function parseDispatch(text, isKnown) {
  const assignments = [];
  let unaddressed = [];
  let current = null;
  let compare = null;
  for (const line of String(text ?? '').split('\n')) {
    let rest = line.replace(/^\s+/, '');
    const targets = [];
    for (;;) {
      const match = MENTION.exec(rest);
      if (!match) break;
      const [whole, rawName, plus, option] = match;
      const name = rawName.toLowerCase();
      if (name === 'compare') {
        compare = { judge: option ? option.toLowerCase() : null };
      } else if (SPECIAL.includes(name) || isKnown(name)) {
        if (option) break;
        if (!targets.some((t) => t.name === name)) targets.push({ name, fresh: plus === '+' });
      } else {
        break;
      }
      rest = rest.slice(whole.length).replace(/^\s+/, '');
    }
    if (targets.length) {
      current = { targets, lines: [rest] };
      assignments.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      unaddressed.push(line);
    }
  }
  return {
    assignments: assignments.map((a) => ({ targets: a.targets, text: a.lines.join('\n').trim() })),
    unaddressed: unaddressed.join('\n').trim(),
    compare,
  };
}

const REVIEW_WORDS = /\b(review|audit|critique|second opinion|double[- ]check)\b|审查|评审|复核|审核|检查一下/i;

export function looksLikeReview(text) {
  return REVIEW_WORDS.test(text);
}

/** `@` completion candidates: agents first, then available harnesses, then specials. */
export function completions(prefix, { agents = [], providers = [] }) {
  const wanted = prefix.replace(/^@/, '').toLowerCase();
  const rows = [
    ...agents.filter((a) => a.state !== 'archived').map((a) => ({ name: a.name, kind: 'agent', detail: `${a.providerName} · ${a.state}` })),
    ...providers.filter((p) => !agents.some((a) => a.name === p.id)).map((p) => ({ name: p.id, kind: 'provider', detail: p.available ? `${p.name}${p.version ? ` ${p.version}` : ''}${p.verified ? '' : ' · untested'}` : `${p.name} · ${p.reason}`, available: p.available })),
    { name: 'all', kind: 'special', detail: 'every agent' },
    { name: 'auto', kind: 'special', detail: 'let Troupe pick' },
    { name: 'compare', kind: 'special', detail: 'compare the answers afterwards' },
  ];
  return rows.filter((row) => row.name.toLowerCase().startsWith(wanted));
}
