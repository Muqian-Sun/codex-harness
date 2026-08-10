# macOS 桌面开发启动

当前仓库已经可以启动真实 Electron 桌面壳，并接通以下链路：

```text
Electron main → Harness daemon → SQLite 状态恢复 + Codex App Server worker → 完整模型目录 + 去敏账户快照
```

界面当前显示这条链路的启动状态，并在就绪后持续显示去敏的当前账户观察、首批可见模型、已注册 Project、默认三级路由配置和每个首屏 Project 的路由绑定状态。用户可以通过原生目录选择器注册工作区，明确配置 `fast`、`standard`、`deep` 的模型与 reasoning effort，再把 Project 显式绑定到该默认路由配置；绑定完成后，还可以为该 Project 创建持久 Task，查看当前 Requirement 详情，并在用户澄清需求时保存新的 Requirement Revision。这些状态都会写入 `state/harness.db` 并在桌面重启后恢复。候选计划生成/确认、TODO/DAG、thread/turn、自动任务分类和智能路由执行尚未开放，不能把“就绪”“已注册”“配置已保存”“已绑定”或“Requirement 已持久化”理解为产品功能已经完整可用。

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
- `ready`：daemon RPC hello、精确 Codex 版本、App Server 初始化、完整模型目录、去敏账户快照、SQLite schema 校验和全部当前领域投影恢复均已通过，main 先并行读取当前账户、首个模型页、首个 Project 页和默认路由配置，再按权威 Project 顺序批量读取绑定状态；任何一步失败都不会发布部分 ready。Task 目录和详情不进入启动原子状态，而是在 ready 后按当前 Project/Task 延迟读取，失败只关闭对应面板，不伪造空状态。后续权威账户快照通过严格、连续的 `account.status_changed` 事件更新。UI 只显示认证状态、凭据类别、已知套餐类别，provider、可见模型总数和最多 12 个模型的名称、推理强度与输入模态，最多 12 个 Project 的 ID/version、显示名、平台、用户明确选择的绝对路径、固定 `unverified` identity 状态及 `unbound`、`default_bound`、`other_profile_bound` 三态和 binding version，路由 profile version、configuration revision、三档目标和当前可用性，所选 Project 最多 12 个 Task 的摘要，以及所选 Task 当前 Requirement 的修订号、原文、objective、constraints 和 acceptance criteria；不显示邮箱、token、目录游标、内部模型 ID、hidden、快照标识、worker session、固定 profile ID、绑定所观察的 configuration revision、Requirement UUID、ownership version、事件时间、事件序号、projection key 或数据库路径。
- `failed`：启动或运行时故障已经保守隔离；界面只显示稳定故障码，不显示路径、stderr 或原始异常。
- `stopping`：正在排空连接并验证受控进程已经退出。

应用不会在失败后自动重启、自动重放或切换到其他 Codex executable。

Electron main 会在应用的私有用户数据目录下分别维护临时 `runtime` root 和稳定 `state` root。单次 daemon 的 socket 与随机运行目录在退出后清理，`state/harness.db` 则跨应用重启保留；renderer 不知道这些内部路径，也不能直接访问 SQLite。数据库只由 daemon 写入，退出时执行 checkpoint 并关闭，正常冒烟要求不残留 `harness.db-wal` 或 `harness.db-shm`。当前桌面开放的业务写入只有不可变 Project 注册、默认 profile 的完整三级路由配置、Project 到该默认 profile 的显式绑定、已绑定 Project 下的初始 Task/Requirement 与 Task → Project 归属原子创建，以及现有 Task 的新 Requirement Revision；Plan Revision、TODO/DAG、RouteDecision、Run、审批和证据仍没有桌面写入口。

Project 注册必须从 renderer 的零参数请求开始。Electron main 只接受当前受管窗口的精确 main frame，打开原生单目录选择器，并根据当前宿主平台、返回的规范绝对路径和路径末段生成注册命令；renderer 不能提交任意路径、Project ID 或 command ID。取消选择不会写入；重复选择同一规范 workspace 会返回已有 Project。当前 `unverified` 只表示保存了通过词法校验的目录描述，不证明目录仍存在、可读写、属于同一物理文件身份、是 Git 仓库或已经获得执行授权。UI 暂时只显示首个 12 项页面，没有主动分页、编辑、重命名或删除。

账户卡是实时去敏观察，但不是账户操作入口，也不授予任务或工具执行权。daemon 内部 worker manager 把合法 `account/updated` 当作失效信号，通过固定 `account/read` 重建权威快照，再由 daemon 发布严格的 `account.status_changed` 事件。桌面会校验事件方法、参数、stream 和连续 sequence；任何缺口、未知事件或断线都会关闭 supervisor 并显示 `daemon_unavailable`，当前不自动重连或重放。登录、退出和 token refresh 仍未开放。

模型目录是当前 Codex worker session 的只读观察。三级路由控制台不会根据模型名称猜测强弱，也不会为未配置状态自动预填：用户必须为每一档明确填写精确模型名称和 reasoning effort。保存前 daemon 要求三个 provider 都等于当前目录 provider、模型当前可见且对应 reasoning effort 被明确支持；不满足时不会写入，也不会回退到近似模型。保存只更新配置，不代表模型获得执行权限；若已有配置后来不再匹配当前目录，界面会保留原映射并显示不可用状态。当前 UI 只显示首个有界目录页面，但可以手工输入未出现在首屏的精确模型名称，由 daemon 使用完整当前目录校验。主动翻页和刷新仍待后续 PR。

Project 路由绑定必须由用户在对应首屏 Project 行明确发起。未配置完整三级路由时按钮禁用；`unbound` 可以首次绑定，`other_profile_bound` 可以明确切换，`default_bound` 不重复写事件。Renderer 只提交当前可见的 Project ID；Electron main 重新校验受管 frame、首屏成员资格和同 Project 单飞，再从 daemon 重读当前 binding/profile fence 并生成 command ID。daemon 最终证明 Project 已注册、默认 profile 已配置且全部乐观锁仍匹配。绑定只引用 profile 身份，profile 后续配置更新会自动生效，不需要重绑；绑定记录中的 profile version 只是写入时审计快照。该动作不检查或授予 shell、文件、网络、凭据、thread/turn 或模型执行权限。

Task 创建必须选择首屏内且处于 `default_bound` 的 Project。Renderer 只提交 Project ID、标题和需求原文；Electron main 重新验证受管 frame、成员资格和绑定状态，按 Project 串行化写入，并生成 Task ID、Task command ID、归属 command ID 以及 Project/binding 乐观锁。daemon 在一个 SQLite 事务内提交 `task.created` 与初始 `task.project_assigned`；完整重试返回既有 Task，半批命令、过期 fence 或不可证明的状态返回稳定冲突，不留下孤立 Task。初始 Requirement 的 `objective` 与原文相同，约束和验收标准暂为空；创建成功后 main 权威重读目录。此入口不生成计划、TODO/DAG、thread/turn、RouteDecision，也不调用模型或工具。

Task 详情读取同时携带 Project ID 与 Task ID；daemon 只在 Project 已注册且 Task 当前归属精确匹配时返回数据。Renderer 看到修订号和 Requirement 内容，但看不到 Requirement UUID 或 ownership version。保存修订时 Renderer 回传页面上显示的 Task version 和新原文；Electron main 重新读取详情，显示版本不再当前时直接冲突，再生成 command UUID 并使用隐藏的 Task/Requirement/ownership fence 请求 daemon。新修订把原文同时作为 objective，并把旧修订派生的 constraints 与 acceptance criteria 置空；旧 Requirement 仍保留在事件日志，旧 candidate/active graph 按领域规则失效，旧 confirmed plan 只作历史参照。冲突不会自动重放或覆盖草稿；界面会只读刷新权威详情与目录，并同时展示当前已持久化原文和草稿供用户比较。结果未知时应重启并按 Requirement 修订号核对。当前尚无执行能力，因此运行中节点的中断与重新验证策略仍由后续安全轮次协调 PR 交付。

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
- Task 标题编辑、删除、移动、主动分页，以及计划、对话、TODO/DAG、审批、证据和路由执行 UI。
- 数据库导出、备份、恢复、重置或迁移操作 UI。
