# Providers

A provider is a coding-agent CLI (a *harness*) that Troupe knows how to start and talk
to. Troupe ships definitions for the common ones; you can change them or add your own,
including closed-source runners, in `~/.troupe/config.json`.

## Built-in harnesses

| Id | Harness | Started as | Protocol | Modes | Checked |
| --- | --- | --- | --- | --- | --- |
| `bizos` | BizOS Code | `bizos acp` | `acp` | all | end-to-end tested |
| `claude` | Claude Code | `claude -p --input-format stream-json …` | `claude-stream` | all | end-to-end tested |
| `codex` | Codex | `codex app-server` | `codex-app` | all | end-to-end tested |
| `opencode` | OpenCode | `opencode acp` | `acp` | all | end-to-end tested |
| `kimi` | Kimi Code | `kimi acp` | `acp` | all | end-to-end tested |
| `dsh` | DeepSeek Harness | `dsh --profile acp` | `acp` | all | end-to-end tested |
| `gemini` | Gemini CLI | `gemini --experimental-acp` | `acp` | all | end-to-end tested |
| `qwen` | Qwen Code | `qwen --experimental-acp` | `acp` | all | end-to-end tested |
| `copilot` | Copilot CLI | `copilot --acp` | `acp` | all | end-to-end tested |
| `goose` | Goose | `goose acp` | `acp` | all | end-to-end tested |
| `cursor` | Cursor Agent | `cursor-agent acp` | `acp` | all | end-to-end tested |
| `amp` | Amp | `amp -x <prompt>` per message | `exec` | full | end-to-end tested |
| `aider` | Aider | `aider --yes-always --no-pretty --message <prompt>` per message | `exec` | full | end-to-end tested |

The rank (the order of this table) decides which harnesses `@auto` and `@all` pick first.

### What "checked" means

All 13 built-in integrations have passed end-to-end checks with real agent installations,
and Windows workflows have also passed end-to-end checks. The built-in definitions therefore
set `verified: true`. This records integration verification; it does not grant permissions,
skip approvals or change sandbox behavior.

The deterministic automated suite also uses mock agents to exercise engine and protocol
behavior. Those fixtures are separate from real-agent end-to-end checks. User-added definitions
and changed invocations need their own verification. Changing a built-in command, protocol,
arguments or one-shot invocation clears its verified status unless the user explicitly sets it.

## Detection

`troupe detect` (or `troupe detect --json`) lists every known harness and whether it can
run here.

- The command is looked up on `PATH`; then in the harness installer's own directory
  (Kimi Code: `$KIMI_CODE_HOME/bin`, by default `~/.kimi-code/bin`); then where package
  and version managers put commands, which a shell or GUI-started process may not have on
  its `PATH`: `~/.local/bin`, `~/.npm-global/bin`, the `npm_config_prefix` and
  `PNPM_HOME` directories, every nvm Node version (newest first), volta, fnm, asdf, mise,
  bun, pnpm, yarn, cargo, go, Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`),
  `~/.opencode/bin`, `~/.claude/local` and, on Windows, `%APPDATA%\npm`,
  `%LOCALAPPDATA%\npm`, `%LOCALAPPDATA%\pnpm`, `Program Files\nodejs` and scoop shims.
- DeepSeek Harness can be installed as a desktop app without registering `dsh`. Troupe
  then uses the CLI inside the app: on macOS its Node script with the app's own Node, on
  Windows the app's `dsh.cmd`.
- On Windows, `.cmd` and `.bat` wrappers are not run through `cmd.exe`: Troupe reads npm's
  wrapper (or DeepSeek Harness desktop's) and starts the program it names directly, so
  arguments are never interpreted by a shell. A wrapper it cannot read is reported as the
  reason the harness failed to start.
- Troupe runs `<command> --version` (or the definition's `versionArgs`) with a 10-second
  limit and reads the version from the output. A harness that does not answer in time is
  still reported as available, with a note; one whose version command fails is not.
- Results are cached for ten minutes and re-checked at once when the executable is
  installed, upgraded or removed (the cache key includes its path and modification time);
  `troupe detect --refresh` checks again.
- A harness that is not available is reported with a reason (`not-installed`,
  `probe-failed`, `launch-failed`) and a fix: the install command, or what went wrong.

## Permission modes

Troupe has four modes (see [spec/orchestration.md §Approvals](../spec/orchestration.md#approvals)).
Each adapter also puts the harness itself in the closest mode it offers, so the harness's
own sandbox agrees with Troupe:

| Troupe mode | Claude Code | Codex | ACP agents | One-shot (`exec`) |
| --- | --- | --- | --- | --- |
| `plan` | `--permission-mode plan` | sandbox `read-only`, approvals `on-request`; Troupe declines every request | the agent's mode named like "plan" | only with `exec.modeArgs.plan` |
| `ask` | `--permission-mode default`; every prompt goes to Troupe | sandbox `read-only`, approvals `on-request` | keeps the agent's mode, unless that mode approves by itself (then "default", "normal", "ask" or "manual") | only with `exec.modeArgs.ask` |
| `workspace` | `--permission-mode default`; Troupe approves edits inside the worktree | sandbox `workspace-write`, approvals `on-request` | "acceptEdits", else "default" | only with `exec.modeArgs.workspace` |
| `full` | `--permission-mode default`; Troupe approves everything | sandbox `workspace-write`, approvals `never` | "bypass", "yolo", "full" or "auto" | always |

One-shot harnesses act without asking, so they run only in `full` unless their definition
maps another mode to flags. When the default mode is not available for a harness, a new
agent gets the closest lower mode it supports; if it supports only higher modes (Amp and
Aider support only `full`), the agent's transcript and a warning say so.

## Your own definitions

`~/.troupe/config.json` (or `$TROUPE_HOME/config.json`) has a `providers` object. An entry
with a built-in id changes only the fields it names:

```json
{
  "providers": {
    "codex": { "args": ["-c", "model_reasoning_effort=high"] },
    "claude": { "command": "/opt/claude/bin/claude", "strictMcp": true }
  }
}
```

An entry with a new id defines a new harness and needs `name`, `command` and `protocol`.

| Field | Meaning |
| --- | --- |
| `name` | Display name. |
| `command` | Executable name on `PATH`, or an absolute path. |
| `protocol` | `acp`, `codex-app`, `claude-stream` or `exec`. |
| `args` | Arguments for the command. For `acp` they are the whole argument list (`["acp"]`); for `codex-app` and `claude-stream` they go before Troupe's own. |
| `modes` | Permission modes the harness may run in. Default: all four; for `exec`, `full` plus the modes in `exec.modeArgs`. |
| `rank` | Order for `@auto`, `@all` and lists; lower first. Default 50. |
| `verified` | `true` if you checked it yourself. Default `false` (shown as "untested"). |
| `writes` | `false` for harnesses that never change files; they work in the project directory without a worktree. |
| `env` | Extra environment variables, as strings. |
| `install`, `signIn` | Hints shown when the harness is missing or needs a sign-in. |
| `versionArgs` | Arguments for detection. Default `["--version"]`. |
| `strictMcp` | `claude-stream` only: also pass `--strict-mcp-config`, so the session loads Troupe's MCP server and no others. |
| `exec` | `exec` only: `{ "args": [...], "modelArgs": [...], "modeArgs": { "plan": [...] } }`. `args` must contain `"{prompt}"`; `modelArgs` may contain `"{model}"`. |

Only this user-level file can name commands. A project directory — possibly someone
else's repository — never decides what Troupe runs.

A one-shot example:

```json
{
  "providers": {
    "mytool": {
      "name": "My Tool",
      "command": "mytool",
      "protocol": "exec",
      "exec": { "args": ["run", "{prompt}"], "modelArgs": ["--model", "{model}"], "modeArgs": { "plan": ["--dry-run"] } }
    }
  }
}
```

`mytool` may then run in `plan` (with `--dry-run`) and `full`.

## BizOS Code

`@bizos` is the BizOS CLI, [BizOS Code](https://code.bizos-ai.com), the BizOS team's coding
agent, started in its ACP mode (`bizos acp`). Its runner is closed source and joins through
the protocol alone.

```sh
curl -fsSL https://bizos-ai.com/code/install.sh | sh    # mainland China: https://bizos-ai.cn/code/install.sh
bizos login
mkdir -p ~/.troupe/worktrees && bizos sandbox grant-write ~/.troupe/worktrees
```

BizOS Code runs its agent, and the MCP servers it starts, in an operating-system sandbox
that reads and writes only the directories you granted. Troupe keeps everything an agent
writes under `$TROUPE_HOME/worktrees/<project-id>/`: each agent's worktree and, in
`.mailbox/`, the mailboxes its collaboration tools use. One grant of
`$TROUPE_HOME/worktrees` therefore covers every project, while Troupe's configuration,
goals, transcripts and mailbox tokens stay outside the sandbox's reach. A grant takes
effect when BizOS Code is idle. With `--shared`, also grant the project directory. The
collaboration tools are started from Troupe's own installation; if that is a source
checkout outside the usual package directories, grant BizOS Code read access to it.

| Troupe mode | BizOS Code mode |
| --- | --- |
| `plan` | Plan |
| `ask` | Build (its default) |
| `workspace` | Accept edits |
| `full` | YOLO |

BizOS Code asks with two options, allow once and reject. "Always allow" in Troupe is kept
as a Troupe rule for that agent and answered as allow once, so later matching requests are
approved by Troupe without asking. In Accept edits it changes existing files without asking
and asks before creating a file or running a command; it calls Troupe's collaboration tools
without asking. Its steps appear under its own tool names (`coding_read`,
`coding_multi_edit`, `coding_create`, `coding_command_start`), and the collaboration tools
under the names it gives MCP tools (`mcp_troupe_…`).

## Bring your own runner

A closed-source agent runtime joins Troupe without publishing anything: it speaks the
[Agent Client Protocol](https://agentclientprotocol.com) on stdin and stdout, and the user
registers it:

```json
{
  "providers": {
    "acme": { "name": "Acme Agent", "command": "/opt/acme/bin/acme-agent", "args": ["--acp"], "protocol": "acp", "rank": 3 }
  }
}
```

`@acme` then takes tasks, asks and answers other agents, and goes through the same
approvals, reviews and goal checks as every other agent. BizOS Code joins exactly this way
and is built in; see [BizOS Code](#bizos-code).

What Troupe needs from an ACP runner:

| Method | Needed for |
| --- | --- |
| `initialize` | Reply with `protocolVersion: 1`. Set `agentCapabilities.loadSession` if sessions can be resumed. Troupe offers no `fs` or `terminal` client capabilities, so the runner reads, writes and runs commands itself. |
| `session/new {cwd, mcpServers}` | Work in `cwd` (the agent's worktree) and start the stdio MCP servers it is given: that is how the runner gets `troupe_ask_agent` and the other collaboration tools. |
| `session/load` or `session/resume` | Optional: continue a conversation after an idle timeout or restart. |
| `session/prompt` | Stream `session/update` notifications (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, optionally `usage_update`) and reply with a `stopReason`. |
| `session/request_permission` | Ask before risky actions, with options of kind `allow_once`, `allow_always` and `reject_once`. Give edits `locations` with absolute paths: Troupe approves edits inside the worktree automatically only when it knows the paths. |
| `session/cancel` | Stop the running turn promptly. |
| `session/set_mode` | Optional: offer modes whose names contain "plan", "default", "acceptEdits" or "bypass", so Troupe's modes map onto yours. |

Report a missing sign-in as JSON-RPC error `-32000`; Troupe shows it as
`TROUPE_AUTH_REQUIRED` with the definition's `signIn` hint. The mock agent in
`test/fixtures/mock-acp-agent.js` is a small working example of this surface, and
`troupe run "@acme say hello" --json` is a quick end-to-end check.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `troupe detect` says not installed | Put the command on `PATH`, or set `command` to an absolute path. |
| `TROUPE_AUTH_REQUIRED` | Run the harness once on its own and sign in. |
| `TROUPE_PLAN_DENIED` | The harness cannot run in that permission mode; pick another with `p` (terminal UI) or the mode menu (web UI). |
| `TROUPE_START_FAILED` or `TROUPE_VERSION_UNSUPPORTED` | Update the harness; check `troupe detect` for its version. |
| An "untested" harness misbehaves | Try overriding `args` for your version, and open an issue with what you found. |
