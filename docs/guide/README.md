# Troupe user guide

[中文](README.zh-CN.md)

Troupe runs the BizOS CLI, Claude Code, Codex, Kimi Code, DeepSeek Harness, OpenCode and other coding agents side by side in one terminal or browser window. This guide walks through using it day to day; the [README](../../README.md) is the overview and the reference.

1. [Install and update](install.md) — requirements, installing a release or the source, `troupe update`
2. [Your first session](getting-started.md) — from an empty project to a reviewed merge
3. [Agents](agents.md) — which coding agents Troupe finds, where it looks, the BizOS CLI, adding your own
4. [Working with agents](working.md) — mentions, permission modes, approvals, worktrees, questions between agents, review and merge, goals
5. [Interfaces](interfaces.md) — the terminal UI, the web UI, `troupe run` for scripts, other machines over SSH
6. [Configuration](configuration.md) — `~/.troupe/config.json`, environment variables, where Troupe keeps its files
7. [Troubleshooting](troubleshooting.md) — an agent is not found, the first message is slow, an agent does not start, and more

For how Troupe is built, see [architecture](../architecture.md), [providers](../providers.md) and the [troupe/1 protocol](../../spec/README.md).
