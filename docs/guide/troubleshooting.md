# Troubleshooting

[中文](troubleshooting.zh-CN.md) · [Guide](README.md)

## An installed agent is not found

`troupe detect` shows `·` and a reason instead of `✓`.

1. Update Troupe first (`troupe update`): each release learns more places where agents are installed. Since 0.1.3 Troupe finds Kimi Code in its installer's folder (`~/.kimi-code/bin`) and DeepSeek Harness from its desktop app even without a `dsh` command.
2. Open a new terminal and run the agent's own version command (`kimi --version`, `dsh --version`). If that fails too, reinstall the agent or finish its setup.
3. `troupe detect --json` shows the command Troupe found (`binary`, empty when none) and why it gave up (`fix`). `troupe detect --refresh` checks again.
4. If the command is somewhere unusual, set it in `~/.troupe/config.json`; see [Agents](agents.md#when-an-agent-is-not-found).

## The first message is slow

The first message to a new agent creates its worktree, a full checkout of the repository, and starts the agent's own process. In a large repository the checkout takes a few seconds; the agent's start-up depends on the agent.

- Keep agents around: their worktrees and sessions are reused, so later messages start at once.
- Several new agents for one message are created together (0.1.3 and later).
- For very large repositories, `--shared` lets agents work in the project directory without their own checkouts, at the cost of isolation.
- `d` (changes) and reviews read only what changed since 0.1.3, so they stay quick in large repositories.

## An agent does not start

The agent's conversation shows the error and its last output.

- Sign in to the agent on its own once (`bizos login`, `claude`, `codex login`, …).
- An agent that is too old for its protocol fails at the start; update it.
- The BizOS CLI needs write access to Troupe's worktrees: `bizos sandbox grant-write ~/.troupe/worktrees`, run once while BizOS Code is idle.
- On Windows, Troupe starts npm's `.cmd` wrappers through the program they name. If it reports that it cannot read a wrapper, reinstall that agent.

## The web UI does not connect

Open the exact address `troupe gui` printed, including the part after `#`: that is the access token. The web UI listens only on this machine; to use Troupe on another machine, run `troupe gui --ssh <host>` on yours.

## "This project is already open"

Only one Troupe can serve a project at a time. Close the other one, or use `--force` if you are sure the process named in the lock is not a Troupe using this project.

## The update check or `troupe update` fails

Both read the release tags with `git ls-remote https://github.com/AI-BizOS/troupe.git`. Run that command yourself to see the error. Behind a proxy, set `git config --global http.proxy …`; to use a mirror, set `TROUPE_UPDATE_REPOSITORY`. If `npm install -g` fails with a permission error, fix npm's global folder (for example with a Node version manager) and run `troupe update` again.

## Reporting a problem

Open an issue at <https://github.com/AI-BizOS/troupe/issues> with `troupe --version`, your operating system, the agent and its version (from `troupe detect`) and what happened. Transcripts are under `~/.troupe/projects/<project>/transcripts`; remove anything private before attaching them. For security problems, see [SECURITY.md](../../SECURITY.md).
