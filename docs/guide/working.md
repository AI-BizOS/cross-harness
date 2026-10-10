# Working with agents

[中文](working.zh-CN.md) · [Guide](README.md)

## Mentions

Mentions count only at the start of a line.

| You type | What happens |
| --- | --- |
| `@codex @claude review src/` | both get the same task and start together |
| `@codex fix it` ⏎ `@kimi test it` | each line is a separate task |
| `@codex+ …` | a new Codex agent with a fresh session |
| `@backend …` | an agent you renamed (`r` in the terminal UI) |
| `@all …` | every agent on the project |
| `@auto …` | cross-harness picks: two different agents for a review, one otherwise |
| `@codex @kimi @compare:claude which is faster?` | Claude compares both answers once they are in |
| no mention | goes to the selected agent |

New agents for one message are created together, so three agents take about as long to start as one.

## Permission modes

Each agent runs in one of four modes; `p` in the terminal UI changes it.

| Mode | What the agent may do on its own |
| --- | --- |
| `plan` | read only: every change and command is refused |
| `ask` | asks you before changing files or running commands |
| `workspace` (default) | changes its own worktree freely, asks before commands |
| `full` | does everything without asking |

In `workspace` mode, edits are automatic only inside the agent's own worktree; edits anywhere else, or inside `.git`, are asked. Requests from other agents (a question, a review) run with the lower of the two agents' modes. Set the default for new agents with `--mode` or in [configuration](configuration.md).

## Worktrees and branches

In a git repository, each agent works in its own worktree under `~/.cross-harness/worktrees`, on a branch named `cross-harness/<agent>` created from the branch you are on. Agents working in parallel never touch each other's files, or yours. The branch stays after a merge, so every change can be traced.

`--shared` makes new agents work directly in the project directory instead; use it for repositories where a second checkout is not practical.

## Agents asking each other

Every agent gets cross-harness's collaboration tools:

| Tool | Purpose |
| --- | --- |
| `cross_harness_list_agents` | who else is working and on what |
| `cross_harness_ask_agent` | ask another agent and wait for its answer |
| `cross_harness_check_answers` | collect answers that arrived later |
| `cross_harness_ask_user` | ask you to decide, optionally with choices |
| `cross_harness_board_read` / `cross_harness_board_write` | shared plans, interface contracts, file ownership |
| `cross_harness_report_progress` | a one-line status |
| `cross_harness_goal_status` | its goal and the latest check results |

You can write on the project board too (`b`). When two agents would wait for each other, cross-harness notices and tells them.

## Review and merge

`d` shows an agent's changes: the files, the diff, how many commits, and whether there is uncommitted work. `m` merges them:

- a different agent reviews the diff first and ends with `VERDICT: PASS` or `VERDICT: FAIL — reason`; you still decide;
- the merge uses `--no-ff` into the branch you were on and commits the agent's pending work first;
- a project with uncommitted changes is refused before anything happens, and a conflict aborts cleanly.

## Goals

A goal says what "done" means and lets cross-harness check it:

```json
{
  "title": "Parser reports line numbers",
  "outcome": "Every parse error says on which line and column it happened.",
  "criteria": [
    { "id": "tests", "text": "The test suite passes", "check": { "run": "npm test" } },
    { "id": "review", "text": "Readable, public API unchanged", "review": { "by": "codex" } }
  ],
  "assignees": ["claude"]
}
```

Press `g` (or open Goals in the web UI) to write one, or let an agent draft it. Before it starts, a goal needs an independent check (a command or a review by another agent), answers to its open questions and your approval of that exact text. While it runs, cross-harness checks the agent's worktree after every turn and sends failures back, up to `maxIterations` times; a merge waits until the checks pass on the tree being merged. Check commands run only after you approve the goal.

## Stopping, resuming, archiving

- `s` stops the selected agent's turn and the commands it started.
- `y` sends your last message again; `u` resumes a paused queue.
- `x` archives an agent; its branch and transcript are kept.
- After `idleMinutes` without work, an agent's session is closed to free memory; the next message resumes it when the agent supports that.
