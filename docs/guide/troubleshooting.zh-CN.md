# 常见问题

[English](troubleshooting.md) · [指南目录](README.zh-CN.md)

## 已安装的代理没有被找到

`troupe detect` 在这个代理前显示 `·` 和原因，而不是 `✓`。

1. 先升级 Troupe（`troupe update`）：每个版本都会认识更多代理的安装位置。从 0.1.3 起，Troupe 能在 Kimi Code 安装器的目录（`~/.kimi-code/bin`）里找到它，也能在没有 `dsh` 命令时通过桌面版找到 DeepSeek Harness。
2. 在新终端里单独运行代理的版本命令（`kimi --version`、`dsh --version`）。如果这也失败，请重装代理或完成它的设置。
3. `troupe detect --json` 显示 Troupe 找到的命令（`binary`，没找到时为空）以及失败原因（`fix`）。`troupe detect --refresh` 重新检查。
4. 命令装在不常见的位置时，在 `~/.troupe/config.json` 里写明，见[代理](agents.zh-CN.md#找不到代理时)。

## 第一条消息很慢

给新代理的第一条消息要创建它的 worktree（完整检出一份仓库），还要启动代理自己的进程。大仓库检出需要几秒钟；代理的启动时间取决于代理本身。

- 保留代理：它们的 worktree 和会话会被复用，之后的消息马上开始。
- 一条消息里要新建的多个代理会同时创建（0.1.3 起）。
- 非常大的仓库可以用 `--shared` 让代理直接在项目目录里工作，不再各自检出，但失去隔离。
- 从 0.1.3 起，`d`（查看改动）和审查只读取有变化的文件，大仓库里也很快。

## 代理启动失败

代理的对话里会显示错误和它最后的输出。

- 先单独登录一次代理（`bizos login`、`claude`、`codex login` 等）。
- 版本太旧、不支持所需协议的代理会在启动时失败，请升级。
- BizOS CLI 需要写入 Troupe 的 worktree：在 BizOS Code 空闲时运行一次 `bizos sandbox grant-write ~/.troupe/worktrees`。
- 在 Windows 上，Troupe 通过 npm `.cmd` 包装脚本指向的程序来启动代理。如果提示无法读取某个包装脚本，请重装那个代理。

## 网页界面连不上

请打开 `troupe gui` 打印的完整地址，包括 `#` 后面的部分：那是访问令牌。网页界面只监听本机；要在另一台机器上使用 Troupe，在你自己的电脑上运行 `troupe gui --ssh <主机>`。

## 提示“项目已被打开”

同一时间只能有一个 Troupe 服务一个项目。关闭另一个；如果确定锁文件里记录的进程不是正在使用这个项目的 Troupe，可以用 `--force`。

## 更新检查或 `troupe update` 失败

两者都用 `git ls-remote https://github.com/AI-BizOS/troupe.git` 读取发布标签。自己运行这条命令就能看到错误。需要代理时设置 `git config --global http.proxy …`；要用镜像，设置 `TROUPE_UPDATE_REPOSITORY`。如果 `npm install -g` 报权限错误，请修好 npm 的全局目录（例如改用 Node 版本管理器）后再运行 `troupe update`。

## 报告问题

在 <https://github.com/AI-BizOS/troupe/issues> 提交 issue，附上 `troupe --version`、操作系统、代理及其版本（来自 `troupe detect`）和发生了什么。对话记录在 `~/.troupe/projects/<项目>/transcripts`，附上之前请删去私密内容。安全问题请看 [SECURITY.md](../../SECURITY.md)。
