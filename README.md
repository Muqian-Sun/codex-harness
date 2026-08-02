# Codex Harness

Codex Harness 是一个基于 Codex App Server 的本地优先桌面任务控制系统，提供持久计划、任务 DAG、智能模型路由、调度、审批、证据验证和故障恢复。

项目按可独立审查的 PR 顺序交付。在安全、审批、恢复和证据门禁实现之前，对应运行时能力保持关闭。

## 设计入口

- [总体设计](docs/architecture/system-design.md)
- [macOS 桌面开发启动](docs/development/macos-desktop.md)
- [总体设计与交付路线 Issue #2](https://github.com/Muqian-Sun/codex-harness/issues/2)

## 开发环境

要求：

- Node.js 24.14.0
- pnpm 10.14.0

安装与验证：

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:build
```

所有仓库变更必须通过功能分支提交 PR，禁止直接推送 `main`。PR 详细设计写在 PR 正文中，不作为 PR 专属文件进入仓库。
