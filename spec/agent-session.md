# Agent session (`troupe/1`)

An agent session is one live conversation with one harness process. Troupe talks to
every harness through the same small interface; an *adapter* translates it to the
harness's own protocol. This document defines that interface and the four adapters of
the reference implementation.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## Commands

| Command | Result | Notes |
| --- | --- | --- |
| `start({sessionId?, model?, permissionMode, mcpServers, onEvent})` | `{sessionId, resumed}` | Starts the process and opens or resumes a session. A resume the harness no longer has MUST fall back to a new session with `resumed:false`; sign-in failures, timeouts and crashes MUST fail. |
| `prompt(text, {signal?})` | `{text, stopReason, usage}` | Runs one turn and resolves with the final answer. One turn at a time per session: a second prompt while one runs fails with `TROUPE_BUSY`. Aborting `signal` cancels the turn; the promise rejects with `TROUPE_CANCELLED`. |
| `steer(text)` | `boolean` | Adds text to the running turn if the harness supports it (Codex); `false` means "queue it instead". |
| `cancel()` | `boolean` | Asks the harness to stop the running turn. Pending approvals are answered `cancel`. |
| `close()` | — | Ends the session and the process group (SIGTERM, then SIGKILL after a grace period). Never rejects. |

`permissionMode` is one of `plan`, `ask`, `workspace`, `full` (see
[orchestration.md](orchestration.md#approvals)). `mcpServers` lists stdio MCP servers
the harness must start — Troupe passes its collaboration server here.

## Events

Adapters emit these events through `onEvent`. Each is a JSON object with a `type`.

| Event | Fields | Meaning |
| --- | --- | --- |
| `session` | `sessionId` | The harness's id for this conversation, used to resume it later. |
| `text` | `text` | The answer so far (a snapshot, not a delta). Adapters SHOULD throttle to about 13 per second. |
| `activity` | `id, kind, title, status, detail?` | A step: `kind` is `command`, `edit`, `read`, `search`, `thinking` or `tool`; `status` is `running`, `done` or `failed`. Later events with the same `id` update it. |
| `plan` | `entries[{content, status}]` | The agent's current plan (`pending`, `in_progress`, `completed`). |
| `usage` | `usage{…}` | Token counts for one model request, in the harness's own field names. |
| `approval` | `id, kind, title, detail?, command?, paths?, options, respond(choice)` | The harness asks permission. For edits, `paths` lists the files the harness says it will change (absolute, or relative to the working directory); an edit without `paths` is never approved automatically. `options` is `["allow_once","allow_always","deny"]`; `respond` returns `false` if the request is no longer pending. |

Text from harnesses is untrusted: consumers MUST remove terminal escape sequences and
control characters before displaying it.

## Adapters

### ACP — Agent Client Protocol, version 1

Used for OpenCode (`opencode acp`), Kimi Code (`kimi acp`), DeepSeek Harness, Gemini
CLI, Qwen Code, Copilot CLI, Goose, Cursor Agent and any custom ACP agent.

| Troupe | ACP |
| --- | --- |
| `start` | `initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}, terminal:false}}`; then `session/load` (if `agentCapabilities.loadSession`) or `session/resume`, else `session/new {cwd, mcpServers}` |
| model | `session/set_config_option` (category `model`) or `session/set_model` |
| mode | `session/set_mode` or the `mode` config option, chosen by name: full → bypass/yolo/full/auto, workspace → acceptEdits/default, ask → default, plan → plan |
| `prompt` | `session/prompt {sessionId, prompt:[{type:"text"}]}` |
| `cancel` | notification `session/cancel` |
| `text` | `session/update` `agent_message_chunk` (accumulated; a tool call or a new message id starts a paragraph) |
| `activity` | `tool_call` / `tool_call_update` (kind: execute→command, edit/delete/move→edit, read, search, think→thinking, fetch/other→tool); `agent_thought_chunk` → `thinking` |
| `plan` | `plan` |
| `usage` | `usage_update` and the prompt result's `usage` |
| `approval` | request `session/request_permission`; `paths` come from the tool call's `locations`, its `diff` content and path-like `rawInput` fields; the reply selects the option whose `kind` matches (`allow_once`, `allow_always`, `reject_once`/`reject_always`) or `{outcome:"cancelled"}` |
| errors | RPC error `-32000` → `TROUPE_AUTH_REQUIRED`; `stopReason:"refusal"` → `TROUPE_PROVIDER_FAILED` |

MCP servers are passed as `{name, command, args, env:[{name,value}]}` with an absolute
`command`.

### Codex — `codex app-server`

Newline-delimited JSON-RPC without the `"jsonrpc"` member. MCP servers become
`-c mcp_servers.<name>.command=…` TOML overrides before the `app-server` argument.

| Troupe | app-server |
| --- | --- |
| `start` | `initialize {clientInfo}`, notification `initialized`, then `thread/resume {threadId, excludeTurns:true, …}` or `thread/start {cwd, approvalPolicy, sandbox, model?}`. "No rollout found" on resume falls back to a new thread. |
| modes | full → `never` + `workspace-write`; workspace → `on-request` + `workspace-write`; ask and plan → `on-request` + `read-only` (plan: every approval is declined) |
| `prompt` | `turn/start {threadId, input:[{type:"text"}]}`; the turn ends with `turn/completed` (`completed`, `interrupted`, `failed`) |
| `steer` | `turn/steer {threadId, input, expectedTurnId}` |
| `cancel` | `turn/interrupt {threadId, turnId}` |
| `text` | `item/agentMessage/delta` and `item/*` for `agentMessage`; the answer is the turn's last agent message |
| `activity` | `commandExecution` (with `item/commandExecution/outputDelta` tail), `fileChange`, `mcpToolCall`, `reasoning` |
| `usage` | `thread/tokenUsage/updated` (`last` per request; repeats of the same `total` are ignored) |
| `approval` | requests `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` (`paths`: the file-change item's paths plus any `grantRoot`); replies `accept`, `acceptForSession`, `decline`, `cancel` |

### Claude Code — headless stream-json

`claude -p --input-format stream-json --output-format stream-json --verbose
--permission-prompt-tool stdio --permission-mode default|plan [--mcp-config JSON]
[--model M] [--resume ID]`, kept alive across turns.

| Troupe | stream-json |
| --- | --- |
| `prompt` | stdin line `{type:"user", message:{role:"user", content:[{type:"text"}]}}`; exactly one `result` line ends the turn |
| `cancel` | `{type:"control_request", request:{subtype:"interrupt"}}` |
| `session` | `system/init` and `result.session_id` |
| `text` | `assistant` text blocks (a new message id replaces the shown answer; sub-agent messages are ignored) |
| `activity` | `tool_use` blocks, finished by `tool_result` (Bash→command, Edit/Write→edit, Read→read, Grep/Glob/WebSearch→search) |
| `approval` | `control_request` `can_use_tool` (`paths`: `file_path` or `notebook_path` of edit tools); the reply is `{behavior:"allow", updatedInput}` or `{behavior:"deny", message, interrupt}`; `control_cancel_request` withdraws it |
| `usage` | `result.usage` |

### One-shot CLIs (`exec`)

Harnesses without a session protocol run once per prompt with an argument template
(`{prompt}`, `{model}`); stdout is the answer and a non-zero exit is
`TROUPE_PROVIDER_FAILED`. They act without asking, so a provider definition MUST list
`modes: ["full"]` unless it maps the other modes to flags.

## Process rules

- Agents run in their own process group so stopping an agent also stops the commands it
  started.
- Adapters MUST NOT write anything to an agent's stdin except protocol messages, and MUST
  tolerate unknown message types and oversized lines (drop them, keep the session).
- A crashed harness rejects the running prompt with `TROUPE_PROCESS_EXITED` and keeps
  the last 8 KB of stderr for diagnosis.
