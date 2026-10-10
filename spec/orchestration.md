# Orchestration (`troupe/1`)

How a user addresses agents, how agents live and wait, who answers permission requests,
how parallel work stays isolated and comes back, and how user interfaces talk to the
engine.

## Dispatch

A message is sent with `send {text, to?}`. Mentions count only at the **start of a
line**; a line that starts with mentions begins a new assignment and the lines after it
belong to that assignment. Unknown names and `@` signs inside sentences are plain text.

| Text | Effect |
| --- | --- |
| `@codex @claude review src/` | One task for several agents, started together. |
| `@codex fix the test` ⏎ `@kimi add edge cases` | One assignment per line. |
| `@backend …` | A named agent. |
| `@codex …` | The project's existing Codex agent if there is one (the idle one first), otherwise a new agent. |
| `@codex+ …` | Always a new agent with a fresh session. |
| `@all …` | Every agent on the project; if there are none, up to four available harnesses. |
| `@auto …` | Troupe picks available harnesses by rank: two different ones when the text asks for a review, otherwise one. Idle agents are preferred to new ones. |
| `@compare` / `@compare:claude` | After every target has answered, one agent (the named one, else a harness not among the targets) compares the answers. |
| text without mentions | Sent to `to` (the agent selected in the interface); without `to` it fails with `TROUPE_NO_TARGET`. Text before the first mention line is prepended to every assignment. |

`send` returns `{dispatched:[{agentId, agent, provider, created, isolation, branch}],
skipped:[{target, reason}]}`; a harness that is not installed, or that does not allow the
requested permission mode, is skipped with the reason and a fix.

Names are lowercase (`^[a-z][a-z0-9_-]{0,31}$`), unique per project, and may not be
`all`, `auto`, `compare` or another harness's id. New agents are named after their harness
(`codex`, then `codex-2`, …).

## Agents

| State | Meaning |
| --- | --- |
| `idle` | A live or resumable session, nothing running. |
| `starting` | The harness process is starting or resuming its session. |
| `running` | A turn is in progress. |
| `stopped` | The user stopped the last turn (or the engine exited during it). |
| `failed` | The last turn failed; `error` holds `{code, message}`. |
| `offline` | No process (idle timeout, mode change or engine restart); the next message resumes the session by id. |
| `archived` | Retired; kept for history. |

Flags shown next to the state: `needsYou` (approvals and questions waiting for the user),
`waitingOn` (blocked in `troupe_ask_agent`), `waitingForSlot`, `checking` (goal check),
`queue` and `queuePaused`.

- **Queue.** Messages to a busy agent wait in its queue. Codex sessions accept extra text
  into the running turn (`steer`); others queue it.
- **Stop.** Stopping cancels the turn *and* ends the process, so nothing keeps writing
  afterwards. Queued messages are paused, not replayed, until the user resumes them.
- **Slots.** At most `maxPerProvider` agents of one harness run at once (default 3); the
  rest show `waitingForSlot`.
- **Idle.** A session idle for `idleMinutes` (default 15) is closed and resumed on demand.

## Approvals

Each agent has a permission mode. Requests are decided in this order:

1. reads and searches — allowed;
2. Troupe's own collaboration tools, recognised by the tool name that starts the request
   (never by text inside a command or its arguments) — allowed;
3. `full` — allowed;
4. `plan` — denied;
5. an edit whose files are unknown, outside the agent's directory (its worktree, or the
   project when it works there) once symbolic links are followed, or inside a `.git`
   directory — **asked**, whatever the rules say;
6. a rule the user created with "always allow" for this agent — allowed;
7. `workspace` and the request edits files — allowed;
8. otherwise — **the user is asked**.

A message sent by another agent (a question, a review request) runs with the lower of the
two agents' modes. "Always allow" stores a rule for that agent only: edits (still limited
by step 5), or commands starting with the same two words (`npm test`). A shell wrapper such
as `bash -lc '…'` is looked through, and a command rule never covers a command that chains,
pipes, redirects or substitutes (`;` `&` `|` `` ` `` `$` `<` `>` `(` `)` or a line break):
those are asked. Unanswered requests expire when the turn ends.

Harnesses enforce their own sandboxes as well: Codex runs `read-only` or
`workspace-write`; Claude Code runs in `default` or `plan` permission mode with every
prompt routed to Troupe; ACP agents are switched to the closest mode they offer. A
harness running in its own "never ask" mode does not ask, so `full` should be given only
to agents whose own sandbox you trust.

## Isolation and merging

In a git repository each new agent (unless `isolation: "shared"`) gets its own worktree
on its own branch:

```
branch   troupe/<name>                (troupe/<name>-<id6> if that branch already exists)
worktree <TROUPE_HOME>/worktrees/<project-id>/<name>-<id6>
base     the branch checked out when the agent was created
```

Outside git, agents share the project directory and Troupe says so.

- **Diff** shows everything the agent changed since its branch left the base — commits,
  uncommitted edits and new files — computed with a private index so the agent's own index
  is untouched.
- **Review** asks another agent (another harness when possible) to read the diff in `plan`
  mode and end with `VERDICT: PASS` or `VERDICT: FAIL — reason`. Only a line that *starts*
  with the verdict counts.
- **Merge** commits pending work in the worktree, then runs `git merge --no-ff` into the
  branch checked out in the project. It refuses a project with uncommitted changes
  (`TROUPE_MERGE_DIRTY`), aborts cleanly on conflict and lists the files
  (`TROUPE_MERGE_CONFLICT`), and, when the agent works on a goal, requires the last goal
  check to have passed on exactly the tree being merged (`TROUPE_GATE_FAILED`; a forced
  merge is recorded). The branch is kept after merging.

## Client protocol

User interfaces use one engine through `call(method, params)` and an event stream. The
same protocol runs in-process, over stdio (`troupe serve --stdio`), over SSH
(`ssh host troupe serve --stdio`) and, wrapped in HTTP, in the web UI.

Over a byte stream it is newline-delimited JSON-RPC 2.0:

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"client":"troupe"}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol":"troupe/1","version":"0.1.3","snapshot":{…}}}
→ {"jsonrpc":"2.0","id":2,"method":"call","params":{"method":"send","params":{"text":"@codex hi"}}}
← {"jsonrpc":"2.0","method":"event","params":{"event":{"seq":42,"type":"agent.updated",…}}}
```

Errors carry the Troupe code in `error.data.code`. Clients MUST refuse a different
`protocol`.

### Methods

`snapshot`, `providers {refresh?}`, `completions {prefix}`, `send {text, to?}`,
`createAgent {provider, name?, mode?, isolation?, model?}`, `prompt {agent, text}`,
`stop`, `resumeQueue`, `retry`, `archive {agent}`, `rename {agent, name}`,
`setMode {agent, mode}`, `setModel {agent, model}`, `transcript {agent, limit?}`,
`approve {id, choice}`, `answerDecision {id, answer}`, `boardWrite {key, value}`,
`diff {agent}`, `review {agent, reviewer?}`, `merge {agent, force?}`, `goalSave {goal}`,
`goalApprove`, `goalStart`, `goalPause`, `goalCheck {id, agent?}`,
`goalConfirm {id, criterion, confirmed}`, `goalDraft {agent, description}`,
`goalDelete {id}`. No other method is reachable.

### Events

Every event has `seq` (increasing), `type` and `at`. A snapshot carries the `seq` it
reflects; clients ignore events with a lower `seq`.

| Type | Payload |
| --- | --- |
| `agent.updated` | `agent` (full public view) |
| `agent.removed` | `agentId` |
| `agent.message` | `agentId`, `entry {id, at, role, text, kind?, from?, activities?, durationMs?, code?, key?, params?, gate?}` |
| `agent.text` | `agentId`, `text` (answer so far) |
| `agent.activity` | `agentId`, `activity {id, kind, title, status, detail}` |
| `agent.plan` | `agentId`, `entries` |
| `approval.requested` / `approval.resolved` | `approval` / `id, choice, delivered` |
| `decision.requested` / `decision.resolved` | `decision` / `id, answer, delivered` |
| `board.updated` | `board {entries}` |
| `goal.updated` | `goal` (or `{id, deleted:true}`) |
| `gate.result` | `goalId`, `gate` |
| `merge.result` | `agentId`, `ok`, `result` or `error` |
| `review.started` | `agentId` (the author), `reviewer`, `reviewerId` |
| `notice` | `level` (`info`, `success`, `warn`, `error`), `text`, `agentId?`, `code?`, `key?`, `params?` |
| `project.updated` | `project`, `providers?` |

Transcript roles: `user`, `assistant`, `question`, `feedback`, `review`, `compare`,
`draft`, `system`, `error`, `gate`.

Messages Troupe writes itself (system entries, notices, the requests it sends on your
behalf) carry `params`, with `code` or `key` naming the message, so that interfaces can
show them in their own language; `text` is the English form, for logs and for
interfaces that do not know the message.

## Error codes

| Code | Meaning |
| --- | --- |
| `TROUPE_START_FAILED` | The harness could not start or open a session. |
| `TROUPE_PROCESS_EXITED` | The harness process exited. |
| `TROUPE_CLOSED` | The session or connection was closed. |
| `TROUPE_TIMEOUT` | A harness or remote engine did not answer in time. |
| `TROUPE_CANCELLED` | The turn was stopped. |
| `TROUPE_BUSY` | The agent or session is busy. |
| `TROUPE_PROMPT_INVALID` | Empty or too long message. |
| `TROUPE_SESSION_INVALID` / `TROUPE_SESSION_UNKNOWN` | Bad session id / the harness returned none. |
| `TROUPE_AUTH_REQUIRED` | The harness needs a sign-in. |
| `TROUPE_PROVIDER_FAILED` | The harness reported a failure. |
| `TROUPE_PROVIDER_UNAVAILABLE` / `TROUPE_PROVIDER_UNKNOWN` | Not installed / no such harness. |
| `TROUPE_VERSION_UNSUPPORTED` | Incompatible protocol version. |
| `TROUPE_RPC_ERROR` / `TROUPE_RPC_UNSUPPORTED` | A JSON-RPC error / method not provided. |
| `TROUPE_OUTPUT_INVALID` | The harness wrote something unreadable. |
| `TROUPE_MCP_INVALID` | Invalid MCP server descriptor. |
| `TROUPE_PERMISSION_INVALID` / `TROUPE_PLAN_DENIED` | Unknown mode / the harness cannot run in this mode. |
| `TROUPE_AGENT_NOT_FOUND` / `TROUPE_AGENT_AMBIGUOUS` / `TROUPE_AGENT_EXISTS` | Agent lookup errors. |
| `TROUPE_NAME_INVALID` | Invalid or reserved name. |
| `TROUPE_NO_TARGET` | A message without mentions and no selected agent. |
| `TROUPE_SLOT_LIMIT` | Reserved for slot limits. |
| `TROUPE_COLLAB_INVALID` / `TROUPE_COLLAB_UNAVAILABLE` / `TROUPE_COLLAB_SELF` / `TROUPE_COLLAB_TARGET_HELD` | Collaboration request errors. |
| `TROUPE_BOARD_KEY_INVALID` / `TROUPE_BOARD_FULL` | Board errors. |
| `TROUPE_DECISION_LIMIT` / `TROUPE_DECISION_NOT_FOUND` | User-question errors. |
| `TROUPE_APPROVAL_NOT_FOUND` / `TROUPE_APPROVAL_INVALID` | Approval errors. |
| `TROUPE_NOT_GIT` / `TROUPE_WORKTREE_FAILED` | Git errors. |
| `TROUPE_MERGE_DIRTY` / `TROUPE_MERGE_CONFLICT` / `TROUPE_MERGE_NOTHING` / `TROUPE_MERGE_FAILED` | Merge refused or failed (`files` lists paths). |
| `TROUPE_GATE_FAILED` / `TROUPE_GATE_NOT_ARMED` | Goal gate errors. |
| `TROUPE_GOAL_INVALID` / `TROUPE_GOAL_NOT_FOUND` | Goal errors. |
| `TROUPE_LOCKED` | The project is open in another engine. |
| `TROUPE_METHOD_UNKNOWN` / `TROUPE_ARGUMENT_INVALID` / `TROUPE_UNAUTHORIZED` | Client protocol errors. |

## State on disk

`TROUPE_HOME` (default `~/.troupe`) holds `config.json`, `projects/<project-id>/` and
`worktrees/<project-id>/`. A project directory contains `agents.json`,
`transcripts/<agent-id>.jsonl`, `board.json`, `decisions.json`, `goals/<goal-id>.json`,
`events.jsonl` (an append-only audit log of dispatches, approvals, merges and gate
results), `mailbox-tokens.json` and `lock.json`. `worktrees/<project-id>/` holds what
agents write: one worktree per isolated agent and `.mailbox/` with their mailboxes.
One engine may open a project at a time.
