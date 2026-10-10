# 配置

[English](configuration.md) · [指南目录](README.zh-CN.md)

Troupe 不需要配置就能用。想修改默认值，创建 `~/.troupe/config.json`（或 `$TROUPE_HOME/config.json`）：

```json
{
  "defaults": { "mode": "workspace", "isolation": "worktree", "maxPerProvider": 3, "idleMinutes": 15, "gateTimeoutSec": 600, "maxIterations": 5 },
  "providers": { "codex": { "args": ["-c", "model_reasoning_effort=high"] } },
  "lang": "zh",
  "starPrompt": true,
  "updateCheck": true
}
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `defaults.mode` | `workspace` | 新代理的权限模式：`plan`、`ask`、`workspace` 或 `full` |
| `defaults.isolation` | `worktree` | `worktree` 给每个新代理独立的 worktree 和分支；`shared` 使用项目目录 |
| `defaults.maxPerProvider` | `3` | 同一种代理最多几个同时工作，其余排队等空位 |
| `defaults.idleMinutes` | `15` | 代理闲置这么久后关闭它的会话 |
| `defaults.gateTimeoutSec` | `600` | 单条目标核查命令最长运行时间 |
| `defaults.maxIterations` | `5` | 未通过的核查最多发回给代理几次，之后需要你处理 |
| `providers` | | 添加代理或修改内置代理的启动方式（见[代理](agents.zh-CN.md#接入你自己的代理)） |
| `lang` | 按系统语言 | `en` 或 `zh` |
| `starPrompt` | `true` | 设为 `false`：从不询问是否给 Troupe 点星标 |
| `updateCheck` | `true` | 设为 `false`：从不检查新版本（见[安装与升级](install.zh-CN.md#升级)） |

只有这个用户级文件能指定要运行的命令。仓库本身不能让 Troupe 执行任何东西，目标核查只在你批准目标后运行。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `TROUPE_HOME` | 用这个目录代替 `~/.troupe` |
| `TROUPE_LANG` | `en` 或 `zh`（否则由 `LC_ALL`、`LC_MESSAGES`、`LANG` 决定） |
| `NO_COLOR` | 终端界面不使用颜色 |
| `TROUPE_NO_STAR_PROMPT` | 从不询问是否点星标 |
| `TROUPE_NO_UPDATE_CHECK` | 从不检查新版本 |
| `TROUPE_UPDATE_REPOSITORY` | 从这个 git 地址（镜像）读取发布标签，代替 GitHub |
| `CI` | CI 系统会设置：不询问星标，也不检查更新 |
| `KIMI_CODE_HOME` | Kimi Code 的安装目录（不是 `~/.kimi-code` 时） |

## Troupe 把文件放在哪里

| 路径 | 内容 |
| --- | --- |
| `~/.troupe/config.json` | 你的配置 |
| `~/.troupe/projects/<项目>/` | 每个项目的代理、对话记录、目标、看板和事件日志 |
| `~/.troupe/worktrees/<项目>/` | 代理的 worktree，以及代理联系 Troupe 用的信箱 |
| `~/.troupe/star.json`、`~/.troupe/update.json` | 星标提示的回答、最近一次更新检查 |

在你的仓库里，Troupe 只会添加代理的分支（`troupe/<代理>`）和 git 自己对这些 worktree 的记录。
