# macOS 桌面开发启动

当前仓库已经可以启动真实 Electron 桌面壳，并接通以下链路：

```text
Electron main → Harness daemon → SQLite 状态恢复 + Codex App Server worker → 完整模型目录 + 去敏账户快照
```

界面当前显示这条链路的启动状态，并在就绪后持续显示去敏的当前账户观察和首批可见模型。模型档位配置、任务创建、TODO/DAG、thread/turn 和智能路由执行尚未开放，不能把“就绪”理解为产品功能已经完整可用。

## 前置条件

- macOS。
- Node.js `24.14.0`。
- pnpm `10.14.0`。
- 一个绝对、可执行且版本精确匹配当前 Schema manifest 的 Codex CLI。当前固定版本可以这样核对：

```sh
/absolute/path/to/codex --version
```

预期输出：

```text
codex-cli 0.146.0-alpha.9.2
```

Harness 不会自动扫描常见安装位置，也不会自动下载或替换 Codex executable。

## 安装与启动

先安装依赖并构建：

```sh
pnpm install --frozen-lockfile
pnpm build
```

再显式传入 Codex 路径并启动：

```sh
CODEX_HARNESS_CODEX_EXECUTABLE=/absolute/path/to/codex pnpm desktop:start
```

`desktop:start` 会重新构建后启动 Electron。macOS 关闭最后一个窗口不会退出应用；可以从 Dock 重新打开窗口。使用 `Command-Q` 退出时，应用会先排空并关闭 daemon、worker 和 SQLite state store。

## 状态含义

- `starting`：正在验证本地资源并启动受控进程链。
- `ready`：daemon RPC hello、精确 Codex 版本、App Server 初始化、完整模型目录、去敏账户快照、SQLite schema 校验和全部当前领域投影恢复均已通过，main 还已并行通过只读 `account.status` 与 `model.catalog_page` 获得当前账户和首个目录页。后续权威账户快照通过严格、连续的 `account.status_changed` 事件更新。UI 只显示认证状态、凭据类别、已知套餐类别，以及 provider、可见模型总数和最多 12 个模型的名称、推理强度与输入模态；不显示邮箱、token、目录游标、内部模型 ID、hidden、快照标识、worker session、观察时间、事件序号或数据库路径。
- `failed`：启动或运行时故障已经保守隔离；界面只显示稳定故障码，不显示路径、stderr 或原始异常。
- `stopping`：正在排空连接并验证受控进程已经退出。

应用不会在失败后自动重启、自动重放或切换到其他 Codex executable。

Electron main 会在应用的私有用户数据目录下分别维护临时 `runtime` root 和稳定 `state` root。单次 daemon 的 socket 与随机运行目录在退出后清理，`state/harness.db` 则跨应用重启保留；renderer 不知道这些路径，也不能直接访问 SQLite。数据库只由 daemon 写入，退出时执行 checkpoint 并关闭，正常冒烟要求不残留 `harness.db-wal` 或 `harness.db-shm`。当前数据库已经恢复 Task/计划、Project 归属和影子路由等既有领域投影，但桌面还没有业务写 RPC，因此这不表示 UI 已经能创建或编辑这些状态。

账户卡是实时去敏观察，但不是账户操作入口，也不授予任务或工具执行权。daemon 内部 worker manager 把合法 `account/updated` 当作失效信号，通过固定 `account/read` 重建权威快照，再由 daemon 发布严格的 `account.status_changed` 事件。桌面会校验事件方法、参数、stream 和连续 sequence；任何缺口、未知事件或断线都会关闭 supervisor 并显示 `daemon_unavailable`，当前不自动重连或重放。登录、退出和 token refresh 仍未开放。

模型目录同样只是当前 Codex worker session 的只读观察，不代表用户已经把某个模型配置到 `fast`、`standard` 或 `deep`，也不代表模型获得执行权限。当前 UI 只显示首个有界页面；主动翻页、刷新和三档配置将在独立 PR 中接入。

## Electron 首次安装与代理

Electron 二进制由锁文件中的精确版本和校验和约束。在需要 HTTPS 代理的环境中，如果 Electron 自带下载器无法建立连接，可以在安装时显式启用它的官方代理开关：

```sh
ELECTRON_GET_USE_PROXY=1 pnpm desktop:start
```

不要提交 `node_modules`、下载压缩包或本地 Codex 路径。

## 当前不支持

- `.app` / DMG 安装包、代码签名、公证和自动更新。
- Windows 和 Linux 桌面运行。
- 任意可执行文件选择或系统级 Codex 自动发现。
- 模型主动分页、刷新和 `fast` / `standard` / `deep` 档位配置。
- 任务、对话、TODO/DAG、审批、证据和路由执行 UI。
- 数据库导出、备份、恢复、重置或迁移操作 UI。
