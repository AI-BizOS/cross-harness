# Install and update

[中文](install.zh-CN.md) · [Guide](README.md)

## Requirements

- Node.js 20.11 or newer and git.
- At least one coding agent installed and signed in, for example the BizOS CLI (`bizos`), Claude Code (`claude`), Codex (`codex`), Kimi Code (`kimi`), DeepSeek Harness (`dsh`) or OpenCode (`opencode`). cross-harness uses each agent's own account and billing.

## Install a release

```sh
npm install -g https://github.com/AI-BizOS/cross-harness/releases/download/v0.2.0/bizos-ai-cross-harness-0.2.0.tgz
cross-harness --version
cross-harness detect
```

`cross-harness detect` lists the agents cross-harness found on this machine. If one you installed is missing, see [Agents](agents.md#when-an-agent-is-not-found).

Every release on the [releases page](https://github.com/AI-BizOS/cross-harness/releases) has the package and a `cross-harness-SHA256SUMS.txt` with its checksum. cross-harness has no runtime dependencies, so the installation needs nothing else from npm.

## Install from source

```sh
git clone https://github.com/AI-BizOS/cross-harness.git
cd cross-harness
npm install -g .
```

`npm install -g .` links the `cross-harness` command to this checkout, so it runs whatever the checkout contains.

## Update

```sh
cross-harness update            # install the newest release
cross-harness update --check    # only say whether there is one
```

`cross-harness update` finds the newest release on GitHub and installs it with the same `npm install -g` command as above. A copy installed from source is updated with git instead; `cross-harness update` tells you the command:

```sh
git -C <your checkout> pull
```

You do not have to remember to check. At most once a day, when you open the terminal UI or the web UI, cross-harness reads the list of release tags from GitHub in the background. When a newer release exists, it says so once and keeps a small "↑ cross-harness x.y.z" mark in the header. The check sends nothing about you or your projects. To turn it off, set `"updateCheck": false` in `~/.cross-harness/config.json` or `CROSS_HARNESS_NO_UPDATE_CHECK=1`; `cross-harness run` and CI never check.

The check and `cross-harness update` use `git ls-remote`, so git's proxy settings apply. Behind a proxy, configure git once:

```sh
git config --global http.proxy http://proxy.example:8080
```

## Uninstall

```sh
npm uninstall -g @bizos-ai/cross-harness
rm -rf ~/.cross-harness          # optional: configuration, transcripts and agent worktrees
```

Remove `~/.cross-harness` only after merging or saving the work in the agents' worktrees: they live under `~/.cross-harness/worktrees`. Their branches (`cross-harness/<agent>`) stay in your repositories either way.

## Existing installations

The project and primary command are now `cross-harness`. Install the current release
above, then use `cross-harness`, `cross-harness gui` and `cross-harness update`.
The former command remains an upgrade alias. Existing configuration and absolute
worktree paths are reused when the new configuration directory does not yet exist;
no project history is copied or deleted. New installations use `~/.cross-harness`.
Update both ends before connecting over SSH.
