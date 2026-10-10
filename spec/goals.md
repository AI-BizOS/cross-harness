# Goals (`cross-harness/1`)

A goal is a written definition of "done" that exists before the work starts and is
checked by cross-harness, not by the agent doing the work. Goals turn "the agent says it is
finished" into "these commands pass and a different agent agrees".

## Document

```json
{
  "schema": "cross-harness.goal/1",
  "id": "goal-3fa2c1d0",
  "title": "Parser reports line numbers",
  "outcome": "Every parse error says on which line and column it happened.",
  "criteria": [
    { "id": "tests", "text": "The test suite passes", "check": { "run": "npm test", "timeoutSec": 600 } },
    { "id": "message", "text": "Errors include line and column", "check": { "run": "node scripts/check-errors.js", "expect": { "output": "line \\d+, column \\d+" } } },
    { "id": "review", "text": "The change is readable and keeps the public API", "review": { "by": "codex" } },
    { "id": "demo", "text": "The product owner saw the demo" }
  ],
  "boundaries": ["Do not change the exported API"],
  "questions": [{ "id": "q1", "text": "Keep Node 18 support?", "answer": "no" }],
  "assignees": ["claude"],
  "maxIterations": 5,
  "status": "running",
  "revision": 3,
  "approvedRevision": 3,
  "confirmations": { "demo": true },
  "gates": [ … ]
}
```

A criterion is checked in exactly one way:

| Kind | Field | Evidence |
| --- | --- | --- |
| Command | `check {run, cwd?, timeoutSec?, expect?}` | cross-harness runs `run` with the system shell in the agent's worktree (`cwd: "project"` runs it in the project directory). It passes when the exit code equals `expect.exitCode` (default 0) and, if given, the output matches the regular expression `expect.output`. |
| Review | `review {by}` | cross-harness asks agent `by` (an agent name or a harness id) to judge this criterion from the diff, in `plan` mode; it passes on a line starting `VERDICT: PASS`. |
| User | neither | Passes when the user confirms it (`confirmations[id]`). |

`status` is `draft`, `approved`, `running`, `met`, `needs-you` or `failed`. Every change
to the title, outcome, criteria, boundaries, questions, assignees or iteration limit
creates a new `revision` and clears the approval.

## Arm gate

A goal can start only when all of these hold (the reference implementation reports each
missing item):

1. a title and an outcome;
2. at least one criterion, each with a description;
3. **at least one independent criterion** — a command or a review;
4. no review criterion is assigned to one of the goal's own assignees;
5. at least one assignee;
6. every open question has an answer;
7. the user approved **this** revision.

Approval is refused while anything other than the approval itself is missing.

## Completion gate

When an assignee finishes a turn of goal work (the briefing, or feedback from a previous
check), cross-harness evaluates every criterion and records a gate result:

```json
{ "iteration": 2, "agent": "claude", "at": "…", "tree": "<git tree id of the worktree>", "passed": false,
  "criteria": [ { "id": "tests", "passed": false, "summary": "exit 1, expected 0: 2 failing", "evidence": { "kind": "command", "command": "npm test", "exitCode": 1, "durationMs": 8123, "outputTail": "…" } } ] }
```

- All criteria pass for every assignee → the goal is `met`.
- Otherwise, below `maxIterations`, the failures and the last lines of output go back to the
  agent as its next message and the loop continues.
- At `maxIterations` the goal becomes `needs-you` and cross-harness stops iterating.

The user can also run the checks on demand (`goalCheck`). Every evaluation, automatic or
manual, requires the user's approval of the goal's current revision, because check
commands may come from an agent's draft.

The working agent's own words are never evidence. Criteria run in its worktree, where it
cannot alter the check's result except by changing the code.

## Merge gate

An agent assigned to a goal can be merged only if its last gate passed **and** the
worktree's current tree is the tree that passed — checked before cross-harness commits pending
work and again for the commit that is merged. Any later change requires a new check, and
when either tree id cannot be computed the merge is refused. The user may force a merge;
the forced merge is written to the audit log.

## Drafting

`goalDraft {agent, description}` asks an agent (in `plan` mode) to propose a goal as JSON.
The draft is always saved as a new goal with status `draft` (an `id` in the agent's reply
is ignored); it still needs the user's approval like any other goal, so an agent cannot
define its own finish line.

## Agent view

`cross_harness_goal_status` shows the assigned agent its goal, the criteria (with the command
or reviewer for each) and the latest results, so it can work towards the actual checks.
