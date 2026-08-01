# Codex Harness 仓库指南

## 架构不变量

- Renderer 永远不能直接访问 shell、文件系统、SQLite、凭据或 Codex 进程。
- Electron main 拥有 Harness daemon 进程，但不拥有应用状态。
- Harness daemon 是 SQLite 的唯一写入者，也是 Codex App Server worker 的唯一所有者。
- 所有跨进程输入在通过 `@codex-harness/protocol` 验证前均不可信。
- 模型档位与权限级别必须作为两个独立决策。
- 模型声称完成不等于已经验证完成。
- 外部 Harness 在上下文压缩后只保证于下一个安全轮次边界恢复状态。

## 文档规范

- 仓库文档、设计说明、Issue 和 PR 正文统一使用中文；包名、类型名、命令、路径、协议方法和其他技术标识保留原文。
- 总体设计的规范版本位于 `docs/architecture/system-design.md`，并由 GitHub Issue #2 跟踪。
- PR 详细设计只写在 PR 正文中，不在仓库创建 PR 专属设计文件。
- 如果 PR 改变架构、依赖、部署、安全、兼容性或跨 PR 契约，必须在同一 PR 中同步更新总体设计。

## 变更流程

- 每个 PR 只包含一个可独立验证的能力。
- 修改源码、测试、配置、脚本、依赖或文档前，必须先完成当前 PR 的详细设计。
- PR 详细设计至少说明职责边界、模块或文件、接口与数据结构、状态与错误处理、安全和兼容性影响，以及测试与验证方案。
- 在前置 PR 合并前，不得开始依赖它的 PR。
- 在审批与证据门禁具备之前，运行时功能必须保持关闭。
- 禁止直接推送 `main`；只允许推送当前 PR 的功能分支。

## 必需验证

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:build
```

每个 PR 必须针对同一个 head SHA 连续完成两轮审查，且没有新增可执行问题，之后才能 squash merge。合并操作必须校验预期 head SHA；确认 PR 已合并并验证目标提交后，删除对应远程和本地功能分支。
