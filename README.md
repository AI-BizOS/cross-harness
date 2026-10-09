# Troupe

**Run Claude Code, Codex, OpenCode, Gemini CLI, Kimi Code and other coding agents side by side — in one terminal or browser tab.** Send one message to several agents, let them ask each other questions, approve what they want to do in one place, give each its own git worktree, and merge their work only after checks you trust have passed.

Troupe is the open cross-harness protocol from [BizOS](https://github.com/AI-BizOS), with a reference implementation that has a terminal UI and a local web UI. It has no runtime dependencies.

[中文说明](README.zh-CN.md) · [Protocol](spec/README.md) · [Architecture](docs/architecture.md) · [Providers](docs/providers.md) · [Comparison](docs/comparison.md)

```
 Troupe │ shop-api (main)  ·  3 agents  ·  1 working  ·  1 need you  ·  ◆ Parser reports line numbers · running
 AGENTS                         │ @codex · Codex · workspace · troupe/codex                     51k tok  working
▶⠸ @codex               working │──────────────────────────────────────────────────────────────────────────────
    $ npm test -- parser        │ you ›
 ! @claude                  ! 1 │   Fix the parser dropping the last line when there is no trailing newline
    Wrote 6 edge-case tests     │
 ○ @kimi                   idle │ @claude asks ›
    troupe/kimi                 │   Will parse() keep throwing ParseError with {line, column}?
                                │
 WAITING FOR YOU (1)            │ @codex ›  14s
  @claude: npm test -- --cover… │   Yes — the error shape stays the same. I wrote it on the board under api.parse.
                                │   ✓ ⚙ troupe.troupe_board_write
 GOALS                          │
  ◆ Parser reports line numbers │ ⠸ @codex working for 1m 35s
                                │   ◐ Fix the tokenizer
 PROJECT BOARD (1)              │   ✓ ✎ src/parser/tokenizer.js
                                │   ⠸ $ npm test -- parser
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
› Message @codex, or start with @agent   ·   Enter send
```

## What it does

- **One message, many agents.** `@codex @claude review src/` starts both at once; one line per agent gives each its own task. `@all`, `@auto` and `@compare:claude` cover the rest.
- **Real sessions, not screen scraping.** Each agent runs through its vendor's own protocol — ACP, `codex app-server` or Claude Code's stream-json — so Troupe sees every command, edit, plan step and permission request as data.
- **Agents talk to each other.** Every agent gets tools to ask another agent (with deadlock detection), ask you for a decision, share a project board and post its status. They work inside agent sandboxes because they go through files, not sockets.
- **You approve in one place.** Permission requests from all agents land in one queue. Choose allow once, always allow for this agent, or deny. Plan, ask, workspace and full modes decide what is automatic.
- **Isolated by default.** In git repositories each agent works in its own worktree on its own branch, so parallel agents never step on each other.
- **Review, then merge.** See an agent's diff, have a *different* agent review it, then merge with `--no-ff`. Dirty projects and conflicts are refused cleanly.
- **Goals with evidence.** Write down what "done" means: commands Troupe runs, reviews by another agent, confirmations by you. Troupe checks the work itself, sends failures back to the agent, and holds merges until the checks pass on the exact tree being merged.
- **Anywhere.** A terminal UI, a local web UI, `troupe run` for scripts and CI, and `--ssh host` to run every agent on another machine.

## Install

Requirements: Node.js 20.11 or newer, git, and at least one coding agent installed and signed in (for example `claude`, `codex`, `opencode`, `kimi`).

```sh
git clone https://github.com/AI-BizOS/troupe.git
cd troupe
npm install -g .        # installs the `troupe` command; there are no dependencies
troupe detect           # shows which agents Troupe found
```

## Quick start

```sh
cd your-project
troupe                  # terminal UI
troupe gui              # or: web UI in your browser
```

Then type a message that starts with the agents you want:

```
@codex fix the failing test in src/parser
@claude add edge-case tests for the parser; ask codex if the error format is unclear
```

Approve what they ask for, watch them work, press `d` to see an agent's changes and `m` to review and merge them.

## Addressing agents

Mentions count only at the start of a line.

| You type | What happens |
| --- | --- |
| `@codex @claude review src/` | both get the same task and start together |
| `@codex fix it` ⏎ `@kimi test it` | each line is a separate task |
| `@backend …` | an agent you named |
| `@codex+ …` | a new Codex agent with a fresh session |
| `@all …` | every agent on the project |
| `@auto …` | Troupe picks: two different agents for a review, one otherwise |
| `@codex @kimi @compare:claude which is faster?` | Claude compares both answers once they are in |
| no mention | goes to the selected agent |

## Terminal UI

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

Chinese and other wide characters are measured correctly; `NO_COLOR` is respected; `--lang zh` (or a Chinese locale) switches the interface to Chinese.

## Web UI

`troupe gui` serves the same features on `127.0.0.1` and opens your browser. The address carries a random token in its fragment; requests without it, from another origin, or with an unexpected `Host` header are refused. It works on a phone-sized window and follows the system's light or dark theme.

## Scripts and CI

```sh
troupe run "@codex @claude review the last commit" --json
troupe run "@codex fix the lint errors" --yes --timeout 900
```

`run` sends the message, waits until every agent it reached is idle, and prints the answers. It never waits for a person: requests a mode would ask about are denied unless you pass `--yes`.

## Other machines

```sh
troupe --ssh dev@buildbox --cwd src/shop-api
troupe gui --ssh dev@buildbox --cwd src/shop-api
```

The interface stays local; the engine, the agents and the worktrees run on the remote host (which needs Troupe installed). A relative `--cwd` starts from your home directory there. The connection is the plain `ssh` command in batch mode: your SSH config, keys, agent and jump hosts apply, password prompts do not, so use key-based login.

## Goals

A goal is a short document: the outcome, acceptance criteria, boundaries, open questions and who works on it.

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

Before it can start, the goal needs an independent check (a command or a review by another agent), answers to its open questions, and your approval of that exact revision. While it runs, Troupe checks the agent's worktree after every turn and sends failures back, up to `maxIterations`. A merge waits until the checks pass on the tree being merged. Press `g` in the terminal UI (or open Goals in the web UI) to write, draft with an agent, approve, start and check goals.

## What agents get

| Tool | Purpose |
| --- | --- |
| `troupe_list_agents` | who else is working and on what |
| `troupe_ask_agent` | ask another agent and wait for its answer |
| `troupe_check_answers` | collect answers that arrived later |
| `troupe_ask_user` | ask you to decide, optionally with choices |
| `troupe_board_read` / `troupe_board_write` | shared plans, interface contracts, file ownership |
| `troupe_report_progress` | a one-line status |
| `troupe_goal_status` | its goal and the latest check results |

## Supported agents

| Agent | Command | Protocol | Checked |
| --- | --- | --- | --- |
| Claude Code | `claude` | stream-json | documented |
| Codex | `codex` | app-server | handshake |
| OpenCode | `opencode acp` | ACP | handshake |
| Kimi Code | `kimi acp` | ACP | handshake |
| DeepSeek Harness | `dsh --profile acp` | ACP | handshake |
| Gemini CLI | `gemini --experimental-acp` | ACP | documented |
| Qwen Code | `qwen --experimental-acp` | ACP | documented |
| Copilot CLI | `copilot --acp` | ACP | documented |
| Goose | `goose acp` | ACP | documented |
| Cursor Agent | `cursor-agent acp` | ACP | documented |
| Amp | `amp -x` | one-shot | documented |
| Aider | `aider --message` | one-shot | documented |

"Handshake" means Troupe's adapter completed the protocol handshake with a real install of that CLI (codex 0.159.1, opencode, kimi, dsh on 2026-10-09); "documented" integrations follow the vendor's documentation and are labelled "untested" in the interface. No integration has yet been run end to end with a real model in Troupe's automated tests: every protocol is exercised with mock agents. See [docs/providers.md](docs/providers.md).

## Bring your own runner

A closed-source agent runtime can join without publishing its code. Make it speak a session protocol — the [Agent Client Protocol](https://agentclientprotocol.com) is the simplest — and register it in `~/.troupe/config.json`:

```json
{
  "providers": {
    "bizos": { "name": "BizOS", "command": "bizos", "args": ["acp"], "protocol": "acp" }
  }
}
```

`@bizos` then works like any other agent: it takes tasks, asks and answers other agents, and its work goes through the same approvals, reviews and goal checks. BizOS's own runner is designed to join Troupe this way and stays closed source; the command above is an example, so use whatever starts your runner as an ACP agent. See [docs/providers.md](docs/providers.md#bring-your-own-runner).

## Configuration

`~/.troupe/config.json` (or `$TROUPE_HOME/config.json`):

```json
{
  "defaults": { "mode": "workspace", "isolation": "worktree", "maxPerProvider": 3, "idleMinutes": 15 },
  "providers": { "codex": { "args": ["-c", "model_reasoning_effort=high"] } },
  "lang": "zh"
}
```

Only this user-level file can name commands to run. A repository cannot make Troupe execute anything by itself; goal checks run only after you approve the goal.

## Security model

- Agents run as you, with your credentials; Troupe adds no privileges. Use the permission modes and each harness's own sandbox to limit them.
- In workspace mode an agent's edits are automatic only inside its own worktree; edits anywhere else, or inside `.git`, are asked. "Always allow" for a command covers that command, never one chained, piped or redirected after it.
- Output from agents is treated as untrusted text: terminal escape sequences are stripped and the web UI never inserts it as HTML.
- The web UI listens only on this machine (127.0.0.1 unless you choose `::1` or `localhost`), requires a random token, checks `Host` and `Origin`, and sends a strict Content-Security-Policy.
- Agent mailboxes are private (0700/0600), requests are authenticated with a per-agent token, and links planted in a mailbox are never followed.
- See [SECURITY.md](SECURITY.md) for reporting.

## Limitations

- Troupe drives agents through their protocols. Agents without one run one-shot (no live session, no approvals, no collaboration tools).
- Integrations marked "untested" may need small argument changes for your version. No integration has yet been run end to end with a real model in the automated tests.
- Windows support is untested.
- There is no built-in editor, terminal, pull-request integration or usage billing; see [docs/comparison.md](docs/comparison.md).

## Development

```sh
npm test        # node --test; every harness protocol is exercised with mock agents
```

The browser test also runs when `TROUPE_PLAYWRIGHT` points at a Playwright installation. See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [Apache License 2.0](LICENSE).
