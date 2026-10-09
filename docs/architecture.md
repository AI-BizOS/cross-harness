# Architecture

This document describes the reference implementation in this repository: how its parts
fit together, where state lives, and why it is built this way. The protocol itself is
specified in [spec/](../spec/README.md); anything described here but not there is an
implementation choice that other implementations may make differently.

## The picture

```
 terminal UI ─┐                            ┌─ Agent ─ adapter ═ harness process (claude, codex, opencode …)
 web UI ──────┼─ client ═ Engine ──────────┼─ Agent ─ adapter ═ harness process
 troupe run ──┘  in-process,               └─ …                        │ starts
                 stdio or SSH                                           ▼
                    ▲                                              troupe mcp
                    └────────── file mailbox (requests / responses) ────┘
```

`═` marks a process boundary. One engine serves one project. Every user interface talks
to it through the same small client protocol, and every harness is reached through the
same agent-session interface, whatever protocol the vendor speaks.

## Modules

| Directory | Role |
| --- | --- |
| `src/protocol` | The shared vocabulary: protocol version, permission modes, event names, limits and error codes. |
| `src/adapters` | One adapter per session protocol (ACP, `codex app-server`, Claude Code stream-json, one-shot). Each turns a vendor protocol into the seven agent-session events of [spec/agent-session.md](../spec/agent-session.md). |
| `src/providers` | The harness registry (built-ins merged with the user's config) and detection of installed CLIs. See [providers.md](providers.md). |
| `src/engine` | `Engine` (one per project: dispatch, approvals, collaboration, merging, goals), `Agent` (one per agent: queue, session, transcript), mention parsing, the approval policy and the client protocol over streams. |
| `src/collab` | The MCP server agents start (`troupe mcp`), the engine's mailbox hub, and the tool definitions. |
| `src/git` | Worktrees, diffs, review input and merges. |
| `src/goals` | Goal documents, the arm gate and gate evaluation. |
| `src/tui`, `src/gui` | The terminal UI and the web UI. `src/tui/store.js` holds the client-side state and is used by both. |
| `src/i18n` | English and Chinese interface strings. |
| `src/util` | JSON-RPC peer, process groups, atomic files, display width, text sanitising. |
| `src/cli` | The `troupe` command. |

`src/index.js` is the public API; other modules are internal.

## One message, end to end

1. The user types `@codex @claude review src/`. The interface calls `send {text, to}`.
2. `dispatch.js` reads mentions at the start of lines: one assignment, two targets.
3. For each target the engine reuses the project's agent of that name or harness, or
   creates one: it checks the harness is installed, creates a worktree on
   `troupe/<name>` and records a system entry in the new agent's transcript.
4. The message joins the agent's queue (Codex can also take it into a running turn).
   `Agent.runNext` waits for a slot (`maxPerProvider`), then opens or resumes the
   session through the adapter, passing the permission mode and Troupe's MCP server.
5. While the turn runs, adapter events become engine events (`agent.text`,
   `agent.activity`, `agent.plan`) with increasing `seq`, delivered to every client.
6. A permission request goes through `policy.decide`. It is answered at once
   (reads, Troupe's own tools, `full`, `plan`, rules, edits inside the worktree in
   `workspace` mode) or becomes `approval.requested` for the user.
7. The turn's answer is appended to the transcript (`agent.message`). If the agent works
   on a goal, the gate runs now. Then the next queued message starts.

## Agents talking to each other

The harness starts `troupe mcp` as a stdio MCP server, with the absolute Node path and
two environment variables: `TROUPE_MAILBOX` (its private directory) and `TROUPE_TOKEN`.
A tool call becomes a JSON file written atomically into `requests/`. The engine's
`MailboxHub` watches the directory where the system allows it and polls every 250 ms,
claims each file by renaming it, checks the token and calls
`Engine.collab(agentId, op, params)`. The answer goes back as a file in
`responses/`, which the MCP server polls for every 150 ms.

Files are used instead of sockets because harnesses often run their tool servers inside
sandboxes that block loopback and Unix sockets but allow file writes in a temporary or
home directory.

`troupe_ask_agent` puts the question in the target's queue as a normal message marked as
coming from the asker, with `modeCap` set to the lower of the two permission modes. The
asker's tool call waits for that turn's answer. The engine keeps a wait-for graph of the
asks that are blocking right now, so two agents never sit out each other's timeout.

## Approvals

`src/engine/policy.js` decides every request in a fixed order (spec:
[orchestration.md §Approvals](../spec/orchestration.md#approvals)). The hard cases:

- **Troupe's own tools** are recognised by the tool name at the start of the title, and only
  for tool requests, so a command that merely mentions `troupe_ask_agent` gains nothing.
- **Edits** are automatic only when every path the harness reports is inside the agent's
  directory once symbolic links are followed, and not inside `.git`. An edit with no
  paths, or with paths elsewhere, is asked even if a rule would allow it.
- **"Always allow" for a command** keeps the first two words of the command (looking
  through `bash -lc '…'`). It never matches a command that chains, pipes, redirects or
  substitutes, so `npm test && curl … | sh` is asked even when `npm test` is allowed.

Harness sandboxes still apply underneath: Codex runs `read-only` or `workspace-write`,
Claude Code runs with every permission prompt routed to Troupe, and ACP agents are moved
to the closest mode they offer.

## Worktrees, review and merge

Each agent gets `git worktree add` on its own branch under
`$TROUPE_HOME/worktrees/<project-id>/`. Diffs and tree ids are computed with a scratch
index (`GIT_INDEX_FILE`), so untracked files are included and the agent's own index is
never touched. Review sends that diff to a different agent in `plan` mode and reads a
`VERDICT:` line. Merge commits pending work in the worktree, refuses a dirty project,
runs `git merge --no-ff` and aborts cleanly on conflict.

## Goals

A goal is a JSON document with a revision number; any change to its content clears the
user's approval. `armProblems` lists what blocks starting it. After each goal turn,
`evaluateGate` runs the commands in the agent's worktree, asks the reviewers and records
the result with the worktree's tree id. Failures go back to the agent until
`maxIterations`. A merge of that agent's branch needs the last gate to have passed on the
same tree id it is about to merge.

## Client protocol and remote engines

`Engine.call(method, params)` is the only entry point, limited to the methods in
`METHODS`. Events carry a `seq`, and a snapshot carries the `seq` it reflects, so a client
that subscribes before taking the snapshot never misses or repeats an event.

- In-process: `localClient(engine)`.
- Over a byte stream: `serveEngine` and `connectRemote` speak newline-delimited JSON-RPC
  2.0 (`troupe serve --stdio`).
- Over SSH: `ssh -T -o BatchMode=yes <host> 'troupe serve --stdio --cwd …'`. The remote
  host runs the engine, agents and worktrees; only the interface is local.
- In the browser: the GUI server wraps the client as `POST /api/call` and
  `GET /api/events` (server-sent events read with `fetch`, so the token travels in an
  `Authorization` header and never in a request URL).

## User interfaces

The terminal UI decodes raw input into key events (CSI, SS3, bracketed paste, Alt and
lone-Escape timing), renders whole frames as pure functions of the store
(`views.js`), and writes only the rows that changed, inside synchronized-output markers
so terminals that support it never show half a frame. Display width uses
`Intl.Segmenter`, so Chinese text, emoji and combining marks line up.

The web UI is plain JavaScript with no build step. Every element is created through the
DOM API and agent text only ever becomes text nodes; styles are set through CSSOM so the
Content-Security-Policy can forbid inline styles and scripts. Both interfaces use the
same store and the same strings, so they show the same state in the same words.

## State on disk

Everything lives under `TROUPE_HOME` (default `~/.troupe`), never in the project:
configuration, one directory per project (agents, transcripts as JSON lines, board,
decisions, goals, an append-only audit log, the mailbox and a lock) and the worktrees.
JSON files are written atomically (temporary file, then rename). The layout is listed in
[orchestration.md §State on disk](../spec/orchestration.md#state-on-disk).

## Processes

Each harness runs in its own process group, so stopping an agent also stops the commands
it started: stop cancels the turn, then sends SIGTERM and later SIGKILL to the group.
Sessions idle for `idleMinutes` are closed and resumed by id on the next message. If the
engine exits during a turn, that agent comes back as `stopped` with a note to check its
changes.

## Testing

Every session protocol has a mock agent in `test/fixtures/` that understands small
directives in the prompt (`[approve]`, `[ask-edit:FILE]`, `[edit:FILE=TEXT]`,
`[mcp:TOOL {…}]`, `[slow]`, `[fail]`). The engine, collaboration, goals, merges, both
interfaces and the client protocol are tested end to end against them with `node:test`.
The terminal UI is driven through a fake terminal and its frames are compared at exact
widths. The web UI's handler is tested in-process, and, when Playwright and Chrome are
available, in a headless browser whose requests are routed to that handler. The JSON
Schemas in `spec/schemas/` are checked against real traffic.

## Choices and their costs

- **Session protocols, not terminal scraping.** Structured events make one approval queue,
  reliable states and agent-to-agent questions possible. The cost: a harness without a
  session protocol only runs one-shot.
- **Files for the agent side.** Works inside sandboxes; costs a few hundred milliseconds of
  polling per tool call.
- **No dependencies.** Easier to audit and install; the interfaces are smaller than a
  framework-based app.
- **One engine per project.** A lock keeps two engines from driving the same agents, so a
  project is open in one interface at a time (the terminal UI or the web UI, local or
  over SSH).
- **English engine messages.** Notices and system entries from the engine are English;
  the interfaces translate their own strings.
