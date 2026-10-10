# Install and update

[中文](install.zh-CN.md) · [Guide](README.md)

## Requirements

- Node.js 20.11 or newer and git.
- At least one coding agent installed and signed in, for example the BizOS CLI (`bizos`), Claude Code (`claude`), Codex (`codex`), Kimi Code (`kimi`), DeepSeek Harness (`dsh`) or OpenCode (`opencode`). Troupe uses each agent's own account and billing.

## Install a release

```sh
npm install -g https://github.com/AI-BizOS/troupe/releases/download/v0.1.3/bizos-ai-troupe-0.1.3.tgz
troupe --version
troupe detect
```

`troupe detect` lists the agents Troupe found on this machine. If one you installed is missing, see [Agents](agents.md#when-an-agent-is-not-found).

Every release on the [releases page](https://github.com/AI-BizOS/troupe/releases) has the package and a `troupe-SHA256SUMS.txt` with its checksum. Troupe has no runtime dependencies, so the installation needs nothing else from npm.

## Install from source

```sh
git clone https://github.com/AI-BizOS/troupe.git
cd troupe
npm install -g .
```

`npm install -g .` links the `troupe` command to this checkout, so it runs whatever the checkout contains.

## Update

```sh
troupe update            # install the newest release
troupe update --check    # only say whether there is one
```

`troupe update` finds the newest release on GitHub and installs it with the same `npm install -g` command as above. A copy installed from source is updated with git instead; `troupe update` tells you the command:

```sh
git -C <your checkout> pull
```

You do not have to remember to check. At most once a day, when you open the terminal UI or the web UI, Troupe reads the list of release tags from GitHub in the background. When a newer release exists, it says so once and keeps a small "↑ Troupe x.y.z" mark in the header. The check sends nothing about you or your projects. To turn it off, set `"updateCheck": false` in `~/.troupe/config.json` or `TROUPE_NO_UPDATE_CHECK=1`; `troupe run` and CI never check.

The check and `troupe update` use `git ls-remote`, so git's proxy settings apply. Behind a proxy, configure git once:

```sh
git config --global http.proxy http://proxy.example:8080
```

## Uninstall

```sh
npm uninstall -g @bizos-ai/troupe
rm -rf ~/.troupe          # optional: configuration, transcripts and agent worktrees
```

Remove `~/.troupe` only after merging or saving the work in the agents' worktrees: they live under `~/.troupe/worktrees`. Their branches (`troupe/<agent>`) stay in your repositories either way.
