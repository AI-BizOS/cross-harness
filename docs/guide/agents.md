# Agents

[中文](agents.zh-CN.md) · [Guide](README.md)

Troupe does not ship any agent. It starts the coding agents installed on your computer through the protocol each one provides, and each keeps its own account, models and billing. The table in the [README](../../README.md#supported-agents) lists the built-in ones; [providers](../providers.md) describes each integration.

## Finding installed agents

```sh
troupe detect             # what Troupe found, with versions
troupe detect --json      # the same with paths and reasons
troupe detect --refresh   # check again instead of using the last result
```

For each agent, Troupe looks for its command in this order:

1. your `PATH`;
2. the folder its own installer uses, when it has one: `~/.kimi-code/bin` for Kimi Code (or `$KIMI_CODE_HOME/bin`);
3. the usual places package and version managers put commands, even when your shell did not add them to `PATH`:
   - npm: `~/.npm-global/bin`, the `npm_config_prefix` folder, `%APPDATA%\npm`, `%LOCALAPPDATA%\npm`, `Program Files\nodejs`
   - nvm (every installed Node version, newest first), volta, fnm, asdf, mise
   - pnpm (`$PNPM_HOME`, `~/Library/pnpm`, `~/.local/share/pnpm`), yarn, bun
   - Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`), cargo, go, `~/.local/bin` (pipx, uv), scoop
4. for DeepSeek Harness, the desktop app: if it is installed but its `dsh` command was never registered, Troupe runs the CLI inside the app with the app's own Node.

Once found, Troupe runs `<command> --version`. An agent that does not answer within 10 seconds, as can happen on its first run, still counts as installed. Results are remembered for a while; installing, upgrading or removing an agent is noticed at once.

On Windows, commands installed by npm are `.cmd` wrappers. Troupe reads the wrapper and starts the program it names directly, so your messages never pass through `cmd.exe`.

### When an agent is not found

1. Check that the agent works on its own in a new terminal: `kimi --version`, `dsh --version`, `codex --version`.
2. Run `troupe detect --json` and read the `fix` field of that agent.
3. If the command lives somewhere unusual, name it in `~/.troupe/config.json`:

   ```json
   { "providers": { "kimi": { "command": "/opt/tools/kimi/bin/kimi" } } }
   ```

   Changing a built-in agent's command marks it "untested" unless you also set `"verified": true`.

## The BizOS CLI

The BizOS CLI ([BizOS Code](https://code.bizos-ai.com)) is built in as `@bizos`. Install it, sign in once, and let it work in Troupe's worktrees:

```sh
curl -fsSL https://bizos-ai.com/code/install.sh | sh    # Windows: irm https://bizos-ai.com/code/install.ps1 | iex
bizos login
mkdir -p ~/.troupe/worktrees && bizos sandbox grant-write ~/.troupe/worktrees
```

BizOS Code runs its agent in an operating-system sandbox that writes only where you allowed it; run the last line once, while BizOS Code is idle. With `--shared`, also grant the project directory.

## Agents with their own protocol notes

| Agent | Started as | Note |
| --- | --- | --- |
| Kimi Code | `kimi acp` | Sign in to Kimi Code once on its own before using it in Troupe. |
| DeepSeek Harness | `dsh --profile acp` | Works with the `dsh` command or, without it, from the desktop app (macOS and Windows). |
| Codex | `codex app-server` | Uses your Codex configuration. |
| Claude Code | `claude -p --input-format stream-json` | Uses your Claude Code configuration. |

## Your own agent

Any agent runtime that speaks a session protocol (the [Agent Client Protocol](https://agentclientprotocol.com) is the simplest) can join without publishing its code:

```json
{
  "providers": {
    "acme": { "name": "Acme Agent", "command": "acme-agent", "args": ["--acp"], "protocol": "acp" }
  }
}
```

`@acme` then works like any other agent. Only this user-level file can name commands to run; a repository cannot make Troupe start anything. See [providers](../providers.md#bring-your-own-runner).
