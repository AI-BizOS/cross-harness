# Your first session

[中文](getting-started.zh-CN.md) · [Guide](README.md)

This walk-through uses the terminal UI. The [web UI](interfaces.md#web-ui) works the same way with buttons.

## 1. Open a project

```sh
cd your-project
cross-harness
```

cross-harness works best in a git repository with at least one commit: each agent then gets its own worktree and branch. In a plain directory, agents share the directory.

The welcome screen lists the agents cross-harness found. Run `cross-harness detect` in another terminal if one you expect is missing.

## 2. Send a message

Start a line with the agents you want:

```
@bizos fix the failing test in src/parser
@codex add edge-case tests for the parser; ask bizos if the error format is unclear
```

Each line is a separate task, and the agents start at the same time. `@codex @claude review src/` gives both the same task. The first message to a new agent takes a moment longer: cross-harness creates its worktree, and the agent starts its session.

## 3. Answer what the agents ask

When an agent wants to do something its permission mode does not allow by itself, such as running a command, it waits for you. Press `a` to see everything that is waiting:

- **Allow once** — this request only.
- **Always allow this for @agent** — the same command again, for this agent. It never covers a command chained, piped or redirected after it.
- **Deny** — the agent is told no and carries on.

Agents can also ask you to decide something; those questions wait in the same place.

## 4. Watch and steer

Select an agent with `↑ ↓` or `1`–`9` to see its conversation, the commands it runs and the files it edits. Type another message to steer an agent while it works; `s` stops it.

## 5. Review and merge

Press `d` to see what the selected agent changed on its branch, then `m`:

1. **Have another agent review it first** (recommended) — a different agent reads the diff and ends with PASS or FAIL.
2. **Merge now without review.**

cross-harness merges with `--no-ff` into the branch you were on and keeps the agent's branch. It refuses to merge into a project with uncommitted changes and stops cleanly on a conflict.

## Next

- [Working with agents](working.md): modes, worktrees, questions between agents, goals
- [Interfaces](interfaces.md): every key, the web UI, scripts
