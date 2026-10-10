# Troubleshooting

[中文](troubleshooting.zh-CN.md) · [Guide](README.md)

## An installed agent is not found

`cross-harness detect` shows `·` and a reason instead of `✓`.

1. Update cross-harness first (`cross-harness update`): each release learns more places where agents are installed. Since 0.2.0 cross-harness finds Kimi Code in its installer's folder (`~/.kimi-code/bin`) and DeepSeek Harness from its desktop app even without a `dsh` command.
2. Open a new terminal and run the agent's own version command (`kimi --version`, `dsh --version`). If that fails too, reinstall the agent or finish its setup.
3. `cross-harness detect --json` shows the command cross-harness found (`binary`, empty when none) and why it gave up (`fix`). `cross-harness detect --refresh` checks again.
4. If the command is somewhere unusual, set it in `~/.cross-harness/config.json`; see [Agents](agents.md#when-an-agent-is-not-found).

## The first message is slow

The first message to a new agent creates its worktree, a full checkout of the repository, and starts the agent's own process. In a large repository the checkout takes a few seconds; the agent's start-up depends on the agent.

- Keep agents around: their worktrees and sessions are reused, so later messages start at once.
- Several new agents for one message are created together (0.2.0 and later).
- For very large repositories, `--shared` lets agents work in the project directory without their own checkouts, at the cost of isolation.
- `d` (changes) and reviews read only what changed since 0.2.0, so they stay quick in large repositories.

## An agent does not start

The agent's conversation shows the error and its last output.

- Sign in to the agent on its own once (`bizos login`, `claude`, `codex login`, …).
- An agent that is too old for its protocol fails at the start; update it.
- The BizOS CLI needs write access to cross-harness's worktrees: `bizos sandbox grant-write ~/.cross-harness/worktrees`, run once while BizOS Code is idle.
- On Windows, cross-harness starts npm's `.cmd` wrappers through the program they name. If it reports that it cannot read a wrapper, reinstall that agent.

## The web UI does not connect

Open the exact address `cross-harness gui` printed, including the part after `#`: that is the access token. The web UI listens only on this machine; to use cross-harness on another machine, run `cross-harness gui --ssh <host>` on yours.

## "This project is already open"

Only one cross-harness can serve a project at a time. Close the other one, or use `--force` if you are sure the process named in the lock is not a cross-harness using this project.

## The update check or `cross-harness update` fails

Both read the release tags with `git ls-remote https://github.com/AI-BizOS/cross-harness.git`. Run that command yourself to see the error. Behind a proxy, set `git config --global http.proxy …`; to use a mirror, set `CROSS_HARNESS_UPDATE_REPOSITORY`. If `npm install -g` fails with a permission error, fix npm's global folder (for example with a Node version manager) and run `cross-harness update` again.

## Reporting a problem

Open an issue at <https://github.com/AI-BizOS/cross-harness/issues> with `cross-harness --version`, your operating system, the agent and its version (from `cross-harness detect`) and what happened. Transcripts are under `~/.cross-harness/projects/<project>/transcripts`; remove anything private before attaching them. For security problems, see [SECURITY.md](../../SECURITY.md).
