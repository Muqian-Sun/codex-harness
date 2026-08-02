# macOS 桌面开发启动

当前仓库已经可以启动真实 Electron 桌面壳，并接通以下链路：

```text
Electron main → Harness daemon → SQLite 状态恢复 + Codex App Server worker → 完整模型目录 + 去敏账户快照
```

界面当前显示这条链路的启动状态，并在就绪后持续显示去敏的当前账户观察、首批可见模型、已注册 Project、默认三级路由配置和每个首屏 Project 的路由绑定状态。用户可以通过原生目录选择器注册工作区，明确配置 `fast`、`standard`、`deep` 的模型与 reasoning effort，再把 Project 显式绑定到该默认路由配置；三类状态都会写入 `state/harness.db` 并在桌面重启后恢复。任务创建、TODO/DAG、thread/turn、自动任务分类和智能路由执行尚未开放，不能把“就绪”“已注册”“配置已保存”或“已绑定”理解为产品功能已经完整可用。

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
- `ready`：daemon RPC hello、精确 Codex 版本、App Server 初始化、完整模型目录、去敏账户快照、SQLite schema 校验和全部当前领域投影恢复均已通过，main 先并行读取当前账户、首个模型页、首个 Project 页和默认路由配置，再按权威 Project 顺序批量读取绑定状态；任何一步失败都不会发布部分 ready。后续权威账户快照通过严格、连续的 `account.status_changed` 事件更新。UI 只显示认证状态、凭据类别、已知套餐类别，provider、可见模型总数和最多 12 个模型的名称、推理强度与输入模态，最多 12 个 Project 的 ID/version、显示名、平台、用户明确选择的绝对路径、固定 `unverified` identity 状态及 `unbound`、`default_bound`、`other_profile_bound` 三态和 binding version，以及路由 profile version、configuration revision、三档目标和当前可用性；不显示邮箱、token、目录游标、内部模型 ID、hidden、快照标识、worker session、固定 profile ID、绑定所观察的 configuration revision、事件时间、事件序号、projection key 或数据库路径。
- `failed`：启动或运行时故障已经保守隔离；界面只显示稳定故障码，不显示路径、stderr 或原始异常。
- `stopping`：正在排空连接并验证受控进程已经退出。

应用不会在失败后自动重启、自动重放或切换到其他 Codex executable。

Electron main 会在应用的私有用户数据目录下分别维护临时 `runtime` root 和稳定 `state` root。单次 daemon 的 socket 与随机运行目录在退出后清理，`state/harness.db` 则跨应用重启保留；renderer 不知道这些内部路径，也不能直接访问 SQLite。数据库只由 daemon 写入，退出时执行 checkpoint 并关闭，正常冒烟要求不残留 `harness.db-wal` 或 `harness.db-shm`。当前桌面开放的业务写入只有不可变 Project 注册、默认 profile 的完整三级路由配置和 Project 到该默认 profile 的显式绑定；Task/计划、Task → Project 归属、RouteDecision、Run、审批和证据仍没有桌面写入口。

Project 注册必须从 renderer 的零参数请求开始。Electron main 只接受当前受管窗口的精确 main frame，打开原生单目录选择器，并根据当前宿主平台、返回的规范绝对路径和路径末段生成注册命令；renderer 不能提交任意路径、Project ID 或 command ID。取消选择不会写入；重复选择同一规范 workspace 会返回已有 Project。当前 `unverified` 只表示保存了通过词法校验的目录描述，不证明目录仍存在、可读写、属于同一物理文件身份、是 Git 仓库或已经获得执行授权。UI 暂时只显示首个 12 项页面，没有主动分页、编辑、重命名或删除。

账户卡是实时去敏观察，但不是账户操作入口，也不授予任务或工具执行权。daemon 内部 worker manager 把合法 `account/updated` 当作失效信号，通过固定 `account/read` 重建权威快照，再由 daemon 发布严格的 `account.status_changed` 事件。桌面会校验事件方法、参数、stream 和连续 sequence；任何缺口、未知事件或断线都会关闭 supervisor 并显示 `daemon_unavailable`，当前不自动重连或重放。登录、退出和 token refresh 仍未开放。

模型目录是当前 Codex worker session 的只读观察。三级路由控制台不会根据模型名称猜测强弱，也不会为未配置状态自动预填：用户必须为每一档明确填写精确模型名称和 reasoning effort。保存前 daemon 要求三个 provider 都等于当前目录 provider、模型当前可见且对应 reasoning effort 被明确支持；不满足时不会写入，也不会回退到近似模型。保存只更新配置，不代表模型获得执行权限；若已有配置后来不再匹配当前目录，界面会保留原映射并显示不可用状态。当前 UI 只显示首个有界目录页面，但可以手工输入未出现在首屏的精确模型名称，由 daemon 使用完整当前目录校验。主动翻页和刷新仍待后续 PR。

Project 路由绑定必须由用户在对应首屏 Project 行明确发起。未配置完整三级路由时按钮禁用；`unbound` 可以首次绑定，`other_profile_bound` 可以明确切换，`default_bound` 不重复写事件。Renderer 只提交当前可见的 Project ID；Electron main 重新校验受管 frame、首屏成员资格和同 Project 单飞，再从 daemon 重读当前 binding/profile fence 并生成 command ID。daemon 最终证明 Project 已注册、默认 profile 已配置且全部乐观锁仍匹配。绑定只引用 profile 身份，profile 后续配置更新会自动生效，不需要重绑；绑定记录中的 profile version 只是写入时审计快照。该动作不检查或授予 shell、文件、网络、凭据、thread/turn 或模型执行权限。

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
- 模型主动分页和刷新。
- Project 主动分页、编辑、重命名和删除，以及物理目录身份复核、macOS security-scoped bookmark 与 Windows 路径授权恢复。
- 任意 Project 路由 profile 管理、自动任务分类、执行前复核和实际模型路由执行。
- 任务、对话、TODO/DAG、审批、证据和路由执行 UI。
- 数据库导出、备份、恢复、重置或迁移操作 UI。
