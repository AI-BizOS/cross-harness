# 安装与升级

[English](install.md) · [指南目录](README.zh-CN.md)

## 环境要求

- Node.js 20.11 或更高版本，以及 git。
- 至少一个已安装并登录的编程代理，例如 BizOS CLI（`bizos`）、Claude Code（`claude`）、Codex（`codex`）、Kimi Code（`kimi`）、DeepSeek Harness（`dsh`）或 OpenCode（`opencode`）。各代理使用自己的账户和计费。

## 安装发布版

```sh
npm install -g https://github.com/AI-BizOS/troupe/releases/download/v0.1.3/bizos-ai-troupe-0.1.3.tgz
troupe --version
troupe detect
```

`troupe detect` 列出 Troupe 在这台机器上找到的代理。如果装了却没列出来，请看[代理](agents.zh-CN.md#找不到代理时)。

[发布页](https://github.com/AI-BizOS/troupe/releases)上的每个版本都附有安装包和记录其校验值的 `troupe-SHA256SUMS.txt`。Troupe 没有运行时依赖，安装时不需要从 npm 下载其他东西。

## 从源码安装

```sh
git clone https://github.com/AI-BizOS/troupe.git
cd troupe
npm install -g .
```

`npm install -g .` 把 `troupe` 命令链接到这个源码目录，运行的就是目录里的代码。

## 升级

```sh
troupe update            # 安装最新发布版
troupe update --check    # 只告诉你有没有新版本
```

`troupe update` 在 GitHub 上找到最新发布版，用和上面相同的 `npm install -g` 命令安装。从源码安装的副本用 git 更新，`troupe update` 会告诉你命令：

```sh
git -C <你的源码目录> pull
```

你不必记着去检查。打开终端界面或网页界面时，Troupe 每天最多一次在后台读取 GitHub 上的发布标签；有新版本时提示一次，并在顶栏保留一个小小的“↑ Troupe x.y.z”标记。这次检查不会发送任何关于你或你项目的信息。想关闭，在 `~/.troupe/config.json` 里设置 `"updateCheck": false`，或设置环境变量 `TROUPE_NO_UPDATE_CHECK=1`；`troupe run` 和 CI 中从不检查。

检查和 `troupe update` 都通过 `git ls-remote` 进行，所以 git 的代理设置同样生效。需要代理时，给 git 配置一次即可：

```sh
git config --global http.proxy http://proxy.example:8080
```

## 卸载

```sh
npm uninstall -g @bizos-ai/troupe
rm -rf ~/.troupe          # 可选：配置、对话记录和代理的 worktree
```

删除 `~/.troupe` 之前，请先合并或保存代理 worktree 里的成果：它们在 `~/.troupe/worktrees` 下。代理的分支（`troupe/<代理>`）无论如何都留在你的仓库里。
