# Troupe

**让 Claude Code、Codex、OpenCode、Gemini CLI、Kimi Code 等编程代理并肩工作——在一个终端或一个浏览器标签页里。** 一条消息派给多个代理；代理之间可以互相提问；所有权限请求集中在一处审批；每个代理有自己的 git worktree；只有通过你信得过的核查，它们的成果才会合并。

Troupe 是 [BizOS](https://github.com/AI-BizOS) 开源的跨 Harness 协议，附带一个参考实现，提供终端界面和本地网页界面，运行时零依赖。

[English](README.md) · [协议](spec/README.md) · [架构](docs/architecture.md) · [代理接入](docs/providers.md) · [对比](docs/comparison.md)

```
 Troupe │ shop-api (main)  ·  3 个代理  ·  1 个工作中  ·  1 项待你处理  ·  ◆ Parser reports line numbers · 进行中
 代理                           │ @codex · Codex · 工作区 · troupe/codex                       51k tok  工作中
▶⠸ @codex                工作中 │──────────────────────────────────────────────────────────────────────────────
    $ npm test -- parser        │ 你 ›
 ! @claude                  ! 1 │   修复 parser 在没有结尾换行时丢最后一行的问题
    Wrote 6 edge-case tests     │
 ○ @kimi                   空闲 │ @claude 提问 ›
    troupe/kimi                 │   Will parse() keep throwing ParseError with {line, column}?
                                │
 等你处理 (1)                   │ @codex ›  14s
  @claude: npm test -- --cover… │   Yes — the error shape stays the same. I wrote it on the board under api.parse.
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
› 发给 @codex，或以 @代理 开头   ·   Enter 发送
```

## 能做什么

- **一条消息，多个代理。** `@codex @claude 审查 src/` 让两个代理同时开始；每行以 `@代理` 开头，就各做各的那一行。还有 `@all`、`@auto`、`@compare:claude`。
- **真正的会话，不是抓屏。** 每个代理都走厂商自己的协议——ACP、`codex app-server` 或 Claude Code 的 stream-json——所以 Troupe 拿到的是结构化数据：每条命令、每次改文件、计划进度和权限请求。
- **代理之间能对话。** 每个代理都带有一组工具：向另一个代理提问（自动检测互相等待）、请你做决定、共享项目看板、汇报进度。它们通过文件信箱通信，不走端口，所以在代理自己的沙箱里也能用。
- **在一处审批。** 所有代理的权限请求进入同一个队列：允许一次、以后都允许这个代理这样做，或拒绝。计划、询问、工作区、完全访问四种模式决定哪些自动放行。
- **默认隔离。** 在 git 仓库里，每个代理有自己的 worktree 和分支，并行工作互不干扰。
- **先审查，再合并。** 查看代理的改动，交给*另一个*代理审查，然后以 `--no-ff` 合并。项目有未提交改动或出现冲突时会干净地拒绝并说明原因。
- **有证据的目标。** 事先写清楚"完成"的标准：Troupe 自己运行的命令、另一个代理的审查、你的确认。Troupe 自己核查成果，把失败项发回给代理，并且只有在被合并的那一版代码通过核查后才允许合并。
- **随处可用。** 终端界面、本地网页界面、供脚本和 CI 使用的 `troupe run`，以及 `--ssh host` 把所有代理放到另一台机器上运行。

## 安装

需要 Node.js 20.11 或更高版本、git，以及至少一个已安装并登录的编程代理（例如 `claude`、`codex`、`opencode`、`kimi`）。

```sh
git clone https://github.com/AI-BizOS/troupe.git
cd troupe
npm install -g .        # 安装 troupe 命令；没有任何依赖
troupe detect           # 查看 Troupe 找到了哪些代理
```

## 快速开始

```sh
cd 你的项目
troupe                  # 终端界面
troupe gui              # 或：在浏览器里打开网页界面
```

然后输入以代理名开头的消息：

```
@codex 修复 src/parser 里失败的测试
@claude 为 parser 补充边界测试；错误格式不清楚就问 codex
```

批准它们的请求，看它们工作；按 `d` 查看某个代理的改动，按 `m` 审查并合并。

## 点名代理

只有写在行首的 `@名字` 才算点名。

| 写法 | 效果 |
| --- | --- |
| `@codex @claude 审查 src/` | 同一个任务交给两个代理，同时开始 |
| `@codex 修复它` ⏎ `@kimi 测试它` | 每一行是一个独立任务 |
| `@backend …` | 你命名过的代理 |
| `@codex+ …` | 新建一个 Codex 代理，开新会话 |
| `@all …` | 项目里的所有代理 |
| `@auto …` | 由 Troupe 选择：审查类任务交给两个不同的代理，其余交给一个 |
| `@codex @kimi @compare:claude 哪个更快？` | 两个回答都到齐后，由 Claude 对比 |
| 不点名 | 发给当前选中的代理 |

## 终端界面

默认在输入框里打字；按 `Esc` 切换到快捷键，按 `i` 或 `Enter` 回到输入。

| 按键 | 作用 |
| --- | --- |
| `Enter` / `Alt+Enter` | 发送 / 换行 |
| `Tab` | 补全 `@代理` |
| `↑ ↓` `j k` `1-9` | 选择代理 |
| `PgUp` `PgDn` | 滚动对话 |
| `a` | 等你处理的审批和问题 |
| `d` / `m` | 查看改动 / 审查并合并 |
| `s` `y` `u` | 停止 · 重发上一条 · 继续已暂停的队列 |
| `n` `p` `r` `x` | 新建代理 · 权限模式 · 改名 · 归档 |
| `g` / `b` | 目标 / 项目看板 |
| `?` / `q` | 帮助 / 退出 |

中文等宽字符的宽度计算正确；遵守 `NO_COLOR`；`--lang zh`（或中文系统语言）切换为中文界面。

## 网页界面

`troupe gui` 在 `127.0.0.1` 上提供同样的功能，并打开浏览器。地址的片段里带有随机令牌；没有令牌、来自其他来源、或 `Host` 头不对的请求一律拒绝。手机宽度可用，跟随系统的浅色或深色主题。

## 脚本与 CI

```sh
troupe run "@codex @claude 审查最近一次提交" --json
troupe run "@codex 修复 lint 错误" --yes --timeout 900
```

`run` 发送消息，等所有被派到的代理空闲后输出它们的回答。它从不等人：按模式需要询问的请求一律拒绝，除非加 `--yes`。

## 在其他机器上运行

```sh
troupe --ssh dev@buildbox --cwd src/shop-api
troupe gui --ssh dev@buildbox --cwd src/shop-api
```

界面留在本机；引擎、代理和 worktree 都在远端主机上运行（远端需要安装 Troupe）。相对路径的 `--cwd` 从远端的用户主目录算起。连接就是以批处理模式运行的普通 `ssh` 命令：你的 SSH 配置、密钥、ssh-agent 和跳板机照常生效，但不会弹出密码提示，所以请使用密钥登录。

## 目标

目标是一份简短的文档：期望结果、验收标准、边界、待定问题，以及由谁来做。

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

开始之前，目标需要至少一项独立核查（一条命令或另一个代理的审查）、所有待定问题都有答案，并且你批准了这一版。运行期间，代理每完成一轮，Troupe 就在它的 worktree 里核查一次，把失败项发回给它，最多 `maxIterations` 轮。合并要等被合并的那一版通过核查。在终端界面按 `g`（或在网页界面打开"目标"），即可编写、让代理起草、批准、开始和核查目标。

## 代理拿到的工具

| 工具 | 用途 |
| --- | --- |
| `troupe_list_agents` | 还有谁在工作，在做什么 |
| `troupe_ask_agent` | 向另一个代理提问并等待回答 |
| `troupe_check_answers` | 收取之后才到的回答 |
| `troupe_ask_user` | 请你做决定，可附选项 |
| `troupe_board_read` / `troupe_board_write` | 共享计划、接口约定、文件归属 |
| `troupe_report_progress` | 一行状态 |
| `troupe_goal_status` | 自己的目标和最近的核查结果 |

## 支持的代理

| 代理 | 命令 | 协议 | 核验情况 |
| --- | --- | --- | --- |
| Claude Code | `claude` | stream-json | 按文档接入 |
| Codex | `codex` | app-server | 握手已验证 |
| OpenCode | `opencode acp` | ACP | 握手已验证 |
| Kimi Code | `kimi acp` | ACP | 握手已验证 |
| DeepSeek Harness | `dsh --profile acp` | ACP | 握手已验证 |
| Gemini CLI | `gemini --experimental-acp` | ACP | 按文档接入 |
| Qwen Code | `qwen --experimental-acp` | ACP | 按文档接入 |
| Copilot CLI | `copilot --acp` | ACP | 按文档接入 |
| Goose | `goose acp` | ACP | 按文档接入 |
| Cursor Agent | `cursor-agent acp` | ACP | 按文档接入 |
| Amp | `amp -x` | 单次运行 | 按文档接入 |
| Aider | `aider --message` | 单次运行 | 按文档接入 |

"握手已验证"表示 Troupe 的适配器已与该 CLI 的真实安装完成协议握手（2026-10-09：codex 0.159.1、opencode、kimi、dsh）；"按文档接入"的按厂商文档实现，界面上标注"未实测"。目前自动化测试里还没有任何集成用真实模型跑过完整流程：每种协议都用模拟代理覆盖。详见 [docs/providers.md](docs/providers.md)。

## 接入你自己的运行器

闭源的代理运行时不必公开代码也能加入：让它支持一种会话协议——最简单的是 [Agent Client Protocol](https://agentclientprotocol.com)——然后在 `~/.troupe/config.json` 里登记：

```json
{
  "providers": {
    "bizos": { "name": "BizOS", "command": "bizos", "args": ["acp"], "protocol": "acp" }
  }
}
```

之后 `@bizos` 就和其他代理一样：接任务、向其他代理提问和回答，它的成果走同样的审批、审查和目标核查。BizOS 自己的运行器按这种方式接入 Troupe，并保持闭源；上面的命令只是示例，换成能以 ACP 方式启动你的运行器的命令即可。详见 [docs/providers.md](docs/providers.md#bring-your-own-runner)。

## 配置

`~/.troupe/config.json`（或 `$TROUPE_HOME/config.json`）：

```json
{
  "defaults": { "mode": "workspace", "isolation": "worktree", "maxPerProvider": 3, "idleMinutes": 15 },
  "providers": { "codex": { "args": ["-c", "model_reasoning_effort=high"] } },
  "lang": "zh"
}
```

只有这个用户级文件可以指定要运行的命令。仓库本身无法让 Troupe 执行任何东西；目标里的核查命令只有在你批准目标后才会运行。

## 安全模型

- 代理以你的身份、用你的凭据运行；Troupe 不额外提权。请用权限模式和各代理自己的沙箱来约束它们。
- 工作区模式下，只有在代理自己的 worktree 里改文件才会自动放行；改其他位置或 `.git` 里的文件都会询问你。对某条命令选"以后都允许"，只覆盖这条命令本身，不覆盖用 `;`、`&&`、管道或重定向接在它后面的命令。
- 代理的输出一律视为不可信文本：终端转义序列会被去除，网页界面从不把它当作 HTML 插入。
- 网页界面只监听本机（默认 127.0.0.1，也可选 `::1` 或 `localhost`），需要随机令牌，校验 `Host` 和 `Origin`，并下发严格的内容安全策略。
- 代理信箱是私有的（0700/0600），请求用每个代理独立的令牌认证，信箱里被放入的链接永远不会被跟随。
- 报告安全问题见 [SECURITY.md](SECURITY.md)。

## 局限

- Troupe 通过代理自己的协议驱动它们。没有会话协议的代理只能单次运行（没有在线会话、审批和协作工具）。
- 标注"未实测"的集成，可能需要针对你的版本微调参数。自动化测试里还没有任何集成用真实模型跑过完整流程。
- 尚未在 Windows 上测试。
- 没有内置编辑器、终端、Pull Request 集成或用量计费；见 [docs/comparison.md](docs/comparison.md)。

## 开发

```sh
npm test        # node --test；每种代理协议都用模拟代理覆盖
```

设置 `TROUPE_PLAYWRIGHT` 指向一个 Playwright 安装时，还会运行浏览器测试。见 [CONTRIBUTING.md](CONTRIBUTING.md)。采用 [Apache License 2.0](LICENSE) 许可。
