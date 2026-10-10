# cross-harness 用户指南

[English](README.md)

cross-harness 让 BizOS CLI、Claude Code、Codex、Kimi Code、DeepSeek Harness、OpenCode 等编程代理在同一个终端或浏览器窗口里并肩工作。这份指南讲日常怎么用；[README](../../README.zh-CN.md) 是总览和参考。

1. [安装与升级](install.zh-CN.md)：环境要求、安装发布版或源码、`cross-harness update`
2. [第一次使用](getting-started.zh-CN.md)：从一个空项目到审查后合并
3. [代理](agents.zh-CN.md)：cross-harness 能找到哪些编程代理、去哪里找、BizOS CLI、接入你自己的代理
4. [和代理一起工作](working.zh-CN.md)：点名、权限模式、审批、worktree、代理互相提问、审查与合并、目标
5. [界面](interfaces.zh-CN.md)：终端界面、网页界面、供脚本使用的 `cross-harness run`、经 SSH 在其他机器上运行
6. [配置](configuration.zh-CN.md)：`~/.cross-harness/config.json`、环境变量、cross-harness 把文件放在哪里
7. [常见问题](troubleshooting.zh-CN.md)：找不到代理、第一条消息慢、代理启动失败等

想了解 cross-harness 的实现，请看[架构](../architecture.md)、[providers](../providers.md) 和 [cross-harness/1 协议](../../spec/README.md)。
