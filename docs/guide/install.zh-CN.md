# 安装与升级

[English](install.md) · [指南目录](README.zh-CN.md)

## 环境要求

- Node.js 20.11 或更高版本，以及 git。
- 至少一个已安装并登录的编程代理，例如 BizOS CLI（`bizos`）、Claude Code（`claude`）、Codex（`codex`）、Kimi Code（`kimi`）、DeepSeek Harness（`dsh`）或 OpenCode（`opencode`）。各代理使用自己的账户和计费。

## 安装发布版

```sh
npm install -g https://github.com/AI-BizOS/cross-harness/releases/download/v0.2.0/bizos-ai-cross-harness-0.2.0.tgz
cross-harness --version
cross-harness detect
```

`cross-harness detect` 列出 cross-harness 在这台机器上找到的代理。如果装了却没列出来，请看[代理](agents.zh-CN.md#找不到代理时)。

[发布页](https://github.com/AI-BizOS/cross-harness/releases)上的每个版本都附有安装包和记录其校验值的 `cross-harness-SHA256SUMS.txt`。cross-harness 没有运行时依赖，安装时不需要从 npm 下载其他东西。

## 从源码安装

```sh
git clone https://github.com/AI-BizOS/cross-harness.git
cd cross-harness
npm install -g .
```

`npm install -g .` 把 `cross-harness` 命令链接到这个源码目录，运行的就是目录里的代码。

## 升级

```sh
cross-harness update            # 安装最新发布版
cross-harness update --check    # 只告诉你有没有新版本
```

`cross-harness update` 在 GitHub 上找到最新发布版，用和上面相同的 `npm install -g` 命令安装。从源码安装的副本用 git 更新，`cross-harness update` 会告诉你命令：

```sh
git -C <你的源码目录> pull
```

你不必记着去检查。打开终端界面或网页界面时，cross-harness 每天最多一次在后台读取 GitHub 上的发布标签；有新版本时提示一次，并在顶栏保留一个小小的“↑ cross-harness x.y.z”标记。这次检查不会发送任何关于你或你项目的信息。想关闭，在 `~/.cross-harness/config.json` 里设置 `"updateCheck": false`，或设置环境变量 `CROSS_HARNESS_NO_UPDATE_CHECK=1`；`cross-harness run` 和 CI 中从不检查。

检查和 `cross-harness update` 都通过 `git ls-remote` 进行，所以 git 的代理设置同样生效。需要代理时，给 git 配置一次即可：

```sh
git config --global http.proxy http://proxy.example:8080
```

## 卸载

```sh
npm uninstall -g @bizos-ai/cross-harness
rm -rf ~/.cross-harness          # 可选：配置、对话记录和代理的 worktree
```

删除 `~/.cross-harness` 之前，请先合并或保存代理 worktree 里的成果：它们在 `~/.cross-harness/worktrees` 下。代理的分支（`cross-harness/<代理>`）无论如何都留在你的仓库里。

## 已有安装升级

项目和主命令现已统一为 `cross-harness`。安装上面的当前发行版后，使用
`cross-harness`、`cross-harness gui` 和 `cross-harness update`。
原命令保留为升级兼容入口。新配置目录尚未建立时会继续使用原配置和原 worktree
绝对路径，不复制或删除项目历史；新安装默认使用 `~/.cross-harness`。
通过 SSH 连接前，请将本地与远端都升级到当前版本。
