# Interfaces

[中文](interfaces.zh-CN.md) · [Guide](README.md)

All interfaces talk to the same engine, one per project, so you can switch between them.

## Terminal UI

```sh
troupe [dir]
```

Type in the composer; press `Esc` to switch to keys, `i` or `Enter` to type again.

| Key | Action |
| --- | --- |
| `Enter` / `Alt+Enter` | send / new line |
| `Tab` | complete `@agent` |
| `↑ ↓` `j k` `1-9` | select an agent |
| `PgUp` `PgDn` | scroll the conversation |
| `a` | approvals and questions waiting for you |
| `d` / `m` | the agent's changes / review and merge |
| `s` `y` `u` | stop · send the last message again · resume a paused queue |
| `n` `p` `r` `x` | new agent · permission mode · rename · archive |
| `g` / `b` | goals / project board |
| `?` / `q` | help / quit |

`--lang zh` (or a Chinese locale) switches the interface to Chinese; `NO_COLOR` turns colours off.

## Web UI

```sh
troupe gui [dir]             # opens your browser
troupe gui --no-open         # prints the address instead
troupe gui --port 7788       # a fixed port
```

The web UI serves the same features on `127.0.0.1`: the agents and their live work, approval cards with one-click answers, diffs, reviews and merges, goals and the project board. The address carries a random token after `#`; requests without it, from another origin or with an unexpected `Host` header are refused, so open the exact address Troupe prints. It follows your light or dark theme and works in a phone-sized window.

## Scripts and CI

```sh
troupe run "@codex @claude review the last commit" --json
troupe run "@codex fix the lint errors" --yes --timeout 900
```

`run` sends the message, waits until every agent it reached is idle, and prints the answers. It never waits for a person: anything a mode would ask about is denied, unless `--yes` (the same as `--mode full`) allows everything. `--timeout` gives up after that many seconds (default 3600). `troupe agents` lists a project's agents.

## Other machines

```sh
troupe --ssh dev@buildbox --cwd src/shop-api
troupe gui --ssh dev@buildbox --cwd src/shop-api
```

The interface stays on your computer; the engine, the agents and their worktrees run on the other machine, which needs Troupe and the agents installed. A relative `--cwd` starts from your home directory there; `--remote-command` says how to start Troupe there if `troupe` is not on its `PATH`. The connection is the plain `ssh` command in batch mode: your SSH configuration, keys, agent and jump hosts apply, password prompts do not, so use key-based login.
