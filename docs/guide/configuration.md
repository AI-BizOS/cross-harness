# Configuration

[中文](configuration.zh-CN.md) · [Guide](README.md)

cross-harness works without configuration. To change its defaults, create `~/.cross-harness/config.json` (or `$CROSS_HARNESS_HOME/config.json`):

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
| `defaults.maxIterations` | `5` | how often cross-harness sends failed goal checks back before the goal needs you |
| `providers` | | add agents or change how a built-in one starts ([Agents](agents.md#your-own-agent)) |
| `lang` | from your locale | `en` or `zh` |
| `starPrompt` | `true` | `false`: never ask about starring cross-harness on GitHub |
| `updateCheck` | `true` | `false`: never check for a newer release ([Install and update](install.md#update)) |

Only this user-level file can name commands to run. A repository cannot make cross-harness execute anything by itself, and goal checks run only after you approve the goal.

## Environment variables

| Variable | Effect |
| --- | --- |
| `CROSS_HARNESS_HOME` | use this directory instead of `~/.cross-harness` |
| `CROSS_HARNESS_LANG` | `en` or `zh` (otherwise `LC_ALL`, `LC_MESSAGES` and `LANG` decide) |
| `NO_COLOR` | no colours in the terminal UI |
| `CROSS_HARNESS_NO_STAR_PROMPT` | never ask about starring cross-harness |
| `CROSS_HARNESS_NO_UPDATE_CHECK` | never check for a newer release |
| `CROSS_HARNESS_UPDATE_REPOSITORY` | read release tags from this git URL (a mirror) instead of GitHub |
| `CI` | set by CI systems: no star prompt and no update check |
| `KIMI_CODE_HOME` | where Kimi Code is installed, if not `~/.kimi-code` |

## Where cross-harness keeps its files

| Path | Contents |
| --- | --- |
| `~/.cross-harness/config.json` | your configuration |
| `~/.cross-harness/projects/<project>/` | each project's agents, transcripts, goals, board and an event log |
| `~/.cross-harness/worktrees/<project>/` | the agents' worktrees, and the mailboxes agents use to reach cross-harness |
| `~/.cross-harness/star.json`, `~/.cross-harness/update.json` | the star prompt's answer and the last update check |

In your repository, cross-harness only adds the agents' branches (`cross-harness/<agent>`) and git's own records of their worktrees.
