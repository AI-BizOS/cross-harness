# 和代理一起工作

[English](working.md) · [指南目录](README.zh-CN.md)

## 点名

只有行首的点名才算数。

| 你输入 | 结果 |
| --- | --- |
| `@codex @claude 审查 src/` | 两个代理拿到同一个任务，同时开始 |
| `@codex 修复它` ⏎ `@kimi 测试它` | 每一行是一个独立任务 |
| `@codex+ …` | 新建一个使用全新会话的 Codex 代理 |
| `@backend …` | 你改过名的代理（终端界面里按 `r`） |
| `@all …` | 项目里的所有代理 |
| `@auto …` | 由 cross-harness 挑选：审查时选两个不同的代理，其他情况选一个 |
| `@codex @kimi @compare:claude 哪个更快？` | 两个回答都到了之后，由 Claude 比较 |
| 不点名 | 发给当前选中的代理 |

一条消息里要新建的多个代理会同时创建，所以启动三个代理和启动一个所需的时间差不多。

## 权限模式

每个代理运行在四种模式之一；终端界面里按 `p` 切换。

| 模式 | 代理可以自动做什么 |
| --- | --- |
| `plan`（计划） | 只读：拒绝一切修改和命令 |
| `ask`（询问） | 改文件、运行命令前都先问你 |
| `workspace`（工作区，默认） | 在自己的 worktree 里自由修改，运行命令前问你 |
| `full`（完全访问） | 全部自动执行，不再询问 |

在工作区模式下，只有在代理自己的 worktree 里改文件才会自动放行；改其他位置或 `.git` 里的文件都会询问你。来自其他代理的请求（提问、审查）按两个代理中较低的模式运行。新代理的默认模式用 `--mode` 或[配置](configuration.zh-CN.md)设定。

## worktree 与分支

在 git 仓库里，每个代理在 `~/.cross-harness/worktrees` 下有自己的 worktree，分支名是 `cross-harness/<代理>`，从你当前所在的分支创建。并行的代理互不碰对方的文件，也不碰你的。合并后分支仍保留，每处改动都可追溯。

`--shared` 让新代理直接在项目目录里工作；适合不方便再检出一份的仓库。

## 代理互相提问

每个代理都会拿到 cross-harness 的协作工具：

| 工具 | 用途 |
| --- | --- |
| `cross_harness_list_agents` | 还有谁在工作、在做什么 |
| `cross_harness_ask_agent` | 向另一个代理提问并等待回答 |
| `cross_harness_check_answers` | 收取之后才到的回答 |
| `cross_harness_ask_user` | 请你做决定，可附带选项 |
| `cross_harness_board_read` / `cross_harness_board_write` | 共享计划、接口约定、文件归属 |
| `cross_harness_report_progress` | 一行状态 |
| `cross_harness_goal_status` | 它的目标和最近的核查结果 |

你也可以在项目看板上写内容（`b`）。两个代理要互相等待时，cross-harness 会发现并告诉它们。

## 审查与合并

`d` 显示代理的改动：文件、diff、提交数，以及有没有未提交的内容。`m` 合并：

- 先由另一个代理审查 diff，最后给出 `VERDICT: PASS` 或 `VERDICT: FAIL — 原因`，由你决定是否合并；
- 以 `--no-ff` 合并到你所在的分支，并先提交代理尚未提交的改动；
- 项目有未提交的改动时，什么都不做就拒绝；出现冲突时干净地中止。

## 目标

目标写清楚“完成”的标准，交给 cross-harness 核查：

```json
{
  "title": "Parser reports line numbers",
  "outcome": "Every parse error says on which line and column it happened.",
  "criteria": [
    { "id": "tests", "text": "The test suite passes", "check": { "run": "npm test" } },
    { "id": "review", "text": "Readable, public API unchanged", "review": { "by": "codex" } }
  ],
  "assignees": ["claude"]
}
```

按 `g`（或在网页界面里打开“目标”）编写目标，也可以让代理起草。开始之前，目标需要一项独立核查（一条命令或另一个代理的审查）、回答完它的待定问题，并由你批准这一版内容。运行期间，cross-harness 在代理每轮结束后核查它的 worktree，把未通过的项发回给代理，最多 `maxIterations` 次；只有被合并的那一版通过核查才允许合并。核查命令只在你批准目标后才会运行。

## 停止、继续、归档

- `s` 停止选中代理当前这一轮，以及它启动的命令。
- `y` 再次发送你的上一条消息；`u` 继续已暂停的队列。
- `x` 归档代理；它的分支和对话记录都会保留。
- 代理闲置 `idleMinutes` 后，cross-harness 会关闭它的会话以释放内存；下一条消息会在代理支持时接上原来的会话。
