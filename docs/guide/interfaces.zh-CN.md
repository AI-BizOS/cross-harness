# 界面

[English](interfaces.md) · [指南目录](README.zh-CN.md)

所有界面都连接同一个引擎（每个项目一个），可以随时切换。

## 终端界面

```sh
cross-harness [目录]
```

在输入框里打字；按 `Esc` 切换到快捷键，按 `i` 或 `Enter` 回到输入。

| 按键 | 作用 |
| --- | --- |
| `Enter` / `Alt+Enter` | 发送 / 换行 |
| `Tab` | 补全 `@代理` |
| `↑ ↓` `j k` `1-9` | 选择代理 |
| `PgUp` `PgDn` | 滚动对话 |
| `a` | 等你处理的审批和问题 |
| `d` / `m` | 代理的改动 / 审查并合并 |
| `s` `y` `u` | 停止 · 再次发送上一条消息 · 继续已暂停的队列 |
| `n` `p` `r` `x` | 新建代理 · 权限模式 · 改名 · 归档 |
| `g` / `b` | 目标 / 项目看板 |
| `?` / `q` | 帮助 / 退出 |

`--lang zh`（或中文系统语言）把界面切换为中文；`NO_COLOR` 关闭颜色。

## 网页界面

```sh
cross-harness gui [目录]            # 打开浏览器
cross-harness gui --no-open         # 只打印地址
cross-harness gui --port 7788       # 使用固定端口
```

网页界面在 `127.0.0.1` 上提供同样的功能：代理和它们实时的工作、一键处理的审批卡片、diff、审查与合并、目标和项目看板。地址里 `#` 后面是随机令牌；没有令牌、来自其他来源或 `Host` 不符的请求都会被拒绝，所以请打开 cross-harness 打印的完整地址。它跟随你的浅色或深色主题，手机宽度也能用。

## 脚本与 CI

```sh
cross-harness run "@codex @claude 审查最近一次提交" --json
cross-harness run "@codex 修复 lint 错误" --yes --timeout 900
```

`run` 发出消息，等所有收到消息的代理空闲后打印它们的回答。它从不等人：模式会询问的请求一律拒绝，除非用 `--yes`（等同于 `--mode full`）全部放行。`--timeout` 在给定秒数后放弃（默认 3600）。`cross-harness agents` 列出项目里的代理。

## 在其他机器上运行

```sh
cross-harness --ssh dev@buildbox --cwd src/shop-api
cross-harness gui --ssh dev@buildbox --cwd src/shop-api
```

界面留在你的电脑上；引擎、代理和它们的 worktree 运行在另一台机器上，那台机器需要安装 cross-harness 和相应的代理。相对的 `--cwd` 从那台机器上你的主目录开始；如果那边的 `PATH` 里没有 `cross-harness`，用 `--remote-command` 指定如何启动。连接使用普通的 `ssh` 命令（batch 模式）：你的 SSH 配置、密钥、agent 和跳板机都有效，但不能输入密码，请使用密钥登录。
