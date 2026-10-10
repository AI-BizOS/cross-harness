# Collaboration (`cross-harness/1`)

Every agent cross-harness starts gets a small set of tools for working with the others: ask
another agent, ask the user, share a board, report progress and read its goal. The
tools are served by an MCP server (`cross-harness mcp`) that the harness itself launches;
the server forwards each call to the engine through a private file mailbox.

## Tools

All tools return MCP text content. Names and inputs are normative; the reply wording is
guidance for the model and may change.

| Tool | Input | Behaviour |
| --- | --- | --- |
| `cross_harness_list_agents` | — | Lists the other non-archived agents on the project: name, harness, state, branch and what each is doing. |
| `cross_harness_ask_agent` | `agent`, `question`, `wait_seconds?` (default 600, max 1800) | Delivers the question to the other agent as its next turn and waits for that turn's answer. If none arrives in time the call returns a question id; the answer is collected later with `cross_harness_check_answers`. |
| `cross_harness_check_answers` | — | Returns answers to earlier questions (to agents and to the user) that arrived after the call stopped waiting. Each answer is returned once. |
| `cross_harness_ask_user` | `question`, `options?` (≤ 6), `wait_seconds?` (default 1800) | Shows the question to the user, optionally with choices, and waits. |
| `cross_harness_board_read` | `key?` | Without a key: every entry's key, author, time and a preview. With a key: that entry in full. |
| `cross_harness_board_write` | `key`, `value` | Writes or replaces an entry; an empty value deletes it. |
| `cross_harness_report_progress` | `status` (≤ 200 chars) | Sets the one-line status shown to the user and the other agents. |
| `cross_harness_goal_status` | — | The goal assigned to this agent, its criteria and the latest check results (see [goals.md](goals.md)). |

The server's `instructions` tell the model to check the board and the other agents
before changing shared code, to ask instead of guessing, and to make goal criteria pass
rather than claim they do.

### Semantics

- **Addressing.** `agent` matches, in order: an agent name, an id prefix of at least four
  characters, a harness id with exactly one agent. Ambiguity fails with
  `CROSS_HARNESS_AGENT_AMBIGUOUS`; asking oneself fails with `CROSS_HARNESS_COLLAB_SELF`.
- **Delivery.** A question becomes an ordinary queued message for the target, marked as
  coming from the asker. The answer is the target's reply to that turn; if that turn
  fails or is stopped, the asker receives a failure instead of an answer.
- **Permissions do not travel.** The target answers in the lower of the two agents'
  permission modes: asking a `full` agent from a `plan` agent cannot run commands.
- **Mutual waits.** The engine keeps a wait-for graph of asks that are currently
  blocking. An ask whose target already waits (directly or transitively) on the asker is
  delivered but returns immediately as pending with `reason: "mutual-wait"`, so two
  agents never sit out each other's full timeout.
- **Held queues.** If the user paused the target's queue, the ask fails with
  `CROSS_HARNESS_COLLAB_TARGET_HELD` instead of releasing the user's paused messages.
- **Decisions.** At most 8 questions per agent may wait for the user
  (`CROSS_HARNESS_DECISION_LIMIT`). Pending decisions survive an engine restart and can still be
  answered; the agent collects them with `cross_harness_check_answers`.
- **Board.** Keys match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`; values are at most 16 000
  characters; a board holds at most 128 entries (`CROSS_HARNESS_BOARD_FULL`). Entries record their
  author and time.

## Transport: the file mailbox

Harnesses often run their tool servers inside sandboxes that block loopback and Unix
sockets but may write files. The mailbox needs only that.

The engine gives each agent a token (64 hex characters) and a directory:

```
<mailboxes>/<token>/requests/<uuid>.json      written by cross-harness mcp
<mailboxes>/<token>/responses/<uuid>.json     written by the engine
```

The reference implementation keeps `<mailboxes>` next to the agents' worktrees, in
`$CROSS_HARNESS_HOME/worktrees/<project-id>/.mailbox/`, and the token registry with its own
state, so a harness that sandboxes its tools needs write access to one directory for
everything its agent writes.

The harness starts `cross-harness mcp` with the environment variables `CROSS_HARNESS_MAILBOX` (the
directory) and `CROSS_HARNESS_TOKEN`.

### Request

```json
{ "id": "6f1c…-uuid", "op": "ask_agent", "params": { "agent": "codex", "question": "…" }, "token": "<64 hex>" }
```

`op` is the tool name without the `cross_harness_` prefix. The writer MUST create the file
atomically (write a temporary name, then rename) and MUST keep requests under 256 KiB.

### Response

```json
{ "id": "6f1c…-uuid", "ok": true, "result": { … } }
{ "id": "6f1c…-uuid", "ok": false, "error": { "code": "CROSS_HARNESS_AGENT_NOT_FOUND", "message": "…" } }
```

### Rules

1. The engine claims a request by renaming it out of `requests/` before reading it, so a
   request runs at most once even if two engines share the directory.
2. Requests without the mailbox's own token, with a malformed id, larger than 256 KiB, or
   that are not regular files are dropped without a response.
3. `requests/` and `responses/` are used only while they are real directories at their
   expected path; symbolic links placed there are removed, never followed.
4. The client polls for its response (reference: every 150 ms). A request still unclaimed
   after 10 s is withdrawn by the client (it deletes the file) and reported as
   `CROSS_HARNESS_COLLAB_UNAVAILABLE`, so it cannot run much later.
5. A waiting call gives up `wait_seconds + 30` seconds after sending and tells the model to
   collect the answer later.
6. Responses nobody collected are deleted after 10 minutes.
7. Mailbox directories are created with mode `0700` and files with `0600`. A mailbox is
   removed when its agent is archived.

## Agents without the tools

One-shot harnesses (`exec`) cannot host an MCP server. They can still be asked questions
— a question is just a queued message — but cannot ask, use the board or report
progress.
