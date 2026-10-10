# Configuration

[中文](configuration.zh-CN.md) · [Guide](README.md)

Troupe works without configuration. To change its defaults, create `~/.troupe/config.json` (or `$TROUPE_HOME/config.json`):

```json
{
  "defaults": { "mode": "workspace", "isolation": "worktree", "maxPerProvider": 3, "idleMinutes": 15, "gateTimeoutSec": 600, "maxIterations": 5 },
  "providers": { "codex": { "args": ["-c", "model_reasoning_effort=high"] } },
  "lang": "zh",
  "starPrompt": true,
  "updateCheck": true
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `defaults.mode` | `workspace` | permission mode of new agents: `plan`, `ask`, `workspace` or `full` |
| `defaults.isolation` | `worktree` | `worktree` gives each new agent its own worktree and branch; `shared` uses the project directory |
| `defaults.maxPerProvider` | `3` | how many agents of one kind work at the same time; others wait for a slot |
| `defaults.idleMinutes` | `15` | an agent's session closes after this long without work |
| `defaults.gateTimeoutSec` | `600` | how long one goal check command may run |
| `defaults.maxIterations` | `5` | how often Troupe sends failed goal checks back before the goal needs you |
| `providers` | | add agents or change how a built-in one starts ([Agents](agents.md#your-own-agent)) |
| `lang` | from your locale | `en` or `zh` |
| `starPrompt` | `true` | `false`: never ask about starring Troupe on GitHub |
| `updateCheck` | `true` | `false`: never check for a newer release ([Install and update](install.md#update)) |

Only this user-level file can name commands to run. A repository cannot make Troupe execute anything by itself, and goal checks run only after you approve the goal.

## Environment variables

| Variable | Effect |
| --- | --- |
| `TROUPE_HOME` | use this directory instead of `~/.troupe` |
| `TROUPE_LANG` | `en` or `zh` (otherwise `LC_ALL`, `LC_MESSAGES` and `LANG` decide) |
| `NO_COLOR` | no colours in the terminal UI |
| `TROUPE_NO_STAR_PROMPT` | never ask about starring Troupe |
| `TROUPE_NO_UPDATE_CHECK` | never check for a newer release |
| `TROUPE_UPDATE_REPOSITORY` | read release tags from this git URL (a mirror) instead of GitHub |
| `CI` | set by CI systems: no star prompt and no update check |
| `KIMI_CODE_HOME` | where Kimi Code is installed, if not `~/.kimi-code` |

## Where Troupe keeps its files

| Path | Contents |
| --- | --- |
| `~/.troupe/config.json` | your configuration |
| `~/.troupe/projects/<project>/` | each project's agents, transcripts, goals, board and an event log |
| `~/.troupe/worktrees/<project>/` | the agents' worktrees, and the mailboxes agents use to reach Troupe |
| `~/.troupe/star.json`, `~/.troupe/update.json` | the star prompt's answer and the last update check |

In your repository, Troupe only adds the agents' branches (`troupe/<agent>`) and git's own records of their worktrees.
