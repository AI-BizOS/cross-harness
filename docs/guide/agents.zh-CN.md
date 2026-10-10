# 代理

[English](agents.md) · [指南目录](README.zh-CN.md)

cross-harness 不自带任何代理。它通过各个编程代理自己提供的协议，启动你电脑上已安装的代理；每个代理保留自己的账户、模型和计费。内置代理见 [README](../../README.zh-CN.md#支持的代理) 里的表格；[providers](../providers.md) 说明每个集成的细节。

## 查找已安装的代理

```sh
cross-harness detect             # cross-harness 找到了什么，以及版本
cross-harness detect --json      # 同上，附带路径和原因
cross-harness detect --refresh   # 重新检查，不用上次的结果
```

对每个代理，cross-harness 按下面的顺序查找它的命令：

1. 你的 `PATH`；
2. 代理自己安装器使用的目录（如果有）：Kimi Code 是 `~/.kimi-code/bin`（或 `$KIMI_CODE_HOME/bin`）；
3. 包管理器和版本管理器通常放命令的位置，即使你的 shell 没有把它们加进 `PATH`：
   - npm：`~/.npm-global/bin`、`npm_config_prefix` 目录、`%APPDATA%\npm`、`%LOCALAPPDATA%\npm`、`Program Files\nodejs`
   - nvm（所有已安装的 Node 版本，新版本优先）、volta、fnm、asdf、mise
   - pnpm（`$PNPM_HOME`、`~/Library/pnpm`、`~/.local/share/pnpm`）、yarn、bun
   - Homebrew（`/opt/homebrew/bin`、`/usr/local/bin`）、cargo、go、`~/.local/bin`（pipx、uv）、scoop
4. DeepSeek Harness 还会找桌面版：装了桌面版但从未注册 `dsh` 命令时，cross-harness 直接用桌面版自带的 Node 运行其中的 CLI。

找到之后，cross-harness 会运行 `<命令> --version`。代理在 10 秒内没有回应（第一次运行时可能如此）也仍算已安装。检查结果会保留一段时间；安装、升级或卸载代理会被立即发现。

在 Windows 上，npm 安装的命令是 `.cmd` 包装脚本。cross-harness 读取包装脚本，直接启动它指向的程序，所以你的消息不会经过 `cmd.exe`。

### 找不到代理时

1. 在新终端里单独运行这个代理：`kimi --version`、`dsh --version`、`codex --version`。
2. 运行 `cross-harness detect --json`，查看这个代理的 `fix` 字段。
3. 命令装在不常见的位置时，在 `~/.cross-harness/config.json` 里写明：

   ```json
   { "providers": { "kimi": { "command": "/opt/tools/kimi/bin/kimi" } } }
   ```

   修改内置代理的命令后，它会被标注为“未实测”，除非你同时设置 `"verified": true`。

## BizOS CLI

BizOS CLI（[BizOS Code](https://code.bizos-ai.com/zh/)）已内置为 `@bizos`。安装、登录一次，再允许它在 cross-harness 的 worktree 里工作：

```sh
curl -fsSL https://bizos-ai.cn/code/install.sh | sh    # Windows：irm https://bizos-ai.cn/code/install.ps1 | iex
bizos login
mkdir -p ~/.cross-harness/worktrees && bizos sandbox grant-write ~/.cross-harness/worktrees
```

BizOS Code 在操作系统沙箱里运行它的代理，只能写入你允许过的目录；最后一行在 BizOS Code 空闲时运行一次即可。使用 `--shared` 时，还要授权项目目录。

## 各代理的协议说明

| 代理 | 启动方式 | 说明 |
| --- | --- | --- |
| Kimi Code | `kimi acp` | 在 cross-harness 里使用前，先单独登录一次 Kimi Code。 |
| DeepSeek Harness | `dsh --profile acp` | 有 `dsh` 命令时用它；没有时用桌面版（macOS 和 Windows）。 |
| Codex | `codex app-server` | 使用你的 Codex 配置。 |
| Claude Code | `claude -p --input-format stream-json` | 使用你的 Claude Code 配置。 |

## 接入你自己的代理

任何支持会话协议（最简单的是 [Agent Client Protocol](https://agentclientprotocol.com)）的代理运行器都能加入，而且不必公开代码：

```json
{
  "providers": {
    "acme": { "name": "Acme Agent", "command": "acme-agent", "args": ["--acp"], "protocol": "acp" }
  }
}
```

之后 `@acme` 就和其他代理一样工作。只有这个用户级文件能指定要运行的命令，仓库本身不能让 cross-harness 启动任何东西。详见 [providers](../providers.md#bring-your-own-runner)。
