# Codex Harness 总体设计

状态：已批准，按独立 PR 增量交付

跟踪入口：[GitHub Issue #2](https://github.com/Muqian-Sun/codex-harness/issues/2)

本文档是 Codex Harness 长期总体设计的仓库内规范版本。PR 专属实现设计记录在对应 PR 正文，不作为独立设计文件进入仓库。

## 1. 背景与问题

Codex 能执行代码、工具和推理任务，但一次对话中的待办列表、依赖关系、完成标准和重要决定主要依赖上下文。长任务发生上下文压缩后，未持久化的计划可能退化或丢失；模型也可能把“声称完成”误当作“已经验证完成”。

Codex Harness 在 Codex App Server 外增加一个本地控制层。Codex 继续负责推理和执行，Harness 负责维护权威任务状态、持久计划、依赖图、模型路由、调度、审批、证据和恢复，并通过桌面端向用户展示这些状态。

## 2. 目标

- 提供类似 Codex 和 Claude 的 Electron 桌面任务界面。
- 把用户需求规范化为可持久化、可恢复、可验证的任务和计划。
- 由 Harness 构建并维护任务节点及 DAG 的权威状态。
- 根据复杂度、系统性、风险和运行反馈选择用户配置的模型档位。
- 在上下文压缩后恢复目标、未完成步骤、约束、决定和证据。
- 对工具调用、写操作和外部副作用实施独立于模型档位的权限控制。
- 使用可审计证据确认完成状态，支持中断、崩溃和重启后的保守恢复。

## 3. 非目标与约束

- V1 不提供桌面关闭后继续执行的常驻后台 daemon。
- V1 不支持连接到任意已存在 daemon；Electron main 每次只拥有一个子 daemon。
- V1 平台交付顺序为 macOS、Windows、Linux。macOS 是首发、打包和端到端验收平台；Windows named pipe 和 Job Object 在第二阶段交付；Linux 的 POSIX 差异、CI 和发布验证排在 Windows 之后。每个平台完成独立实现与证据门禁前，不得宣称该平台生产可用。
- 必需 CI 跟随当前交付平台：macOS 阶段使用固定 macOS runner；Windows 和 Linux 的必需 job 在对应平台能力开始交付时分别加入，不用尚未支持的平台结果阻塞当前平台 PR。
- V1 不保证操作系统或断电故障、两个监督者同时消失，或恶意后代进程逃逸受控 Unix 进程组后的强隔离。
- V1 先采用串行调度；并行调度必须作为后续独立能力设计。
- 模型不能直接提交权威任务状态，也不能自行提高权限。
- 未实现审批、证据和恢复门禁前，不启用对应高风险运行时能力。

## 4. 高层架构

```mermaid
flowchart LR
    Renderer["React Renderer"]
    Main["Electron Main"]
    Harness["Harness Daemon"]
    Store[("SQLite WAL")]
    AppServer["Codex App Server Workers"]

    Renderer <-->|"白名单 Preload IPC"| Main
    Main <-->|"版本化本地 RPC"| Harness
    Harness <--> Store
    Harness <-->|"stdio 上的 JSONL"| AppServer
```

### 4.1 进程职责

- Renderer 是不可信展示层，不启用 Node integration，也不获得原始 IPC、shell、文件系统、SQLite、凭据或 Codex 进程访问能力。
- Electron main 负责安全窗口、白名单 preload API、本地 RPC 客户端和一个 Harness daemon 子进程，但不持有业务状态。
- Harness daemon 是应用状态、SQLite 写入、调度、路由以及 Codex App Server worker 的唯一所有者。
- Codex App Server 保持 agent 执行边界；Harness 不复制其推理职责。
- App Server stdout 只承载协议消息，stderr 只承载诊断，二者不得混合。

### 4.2 信任边界

所有跨进程输入、数据库反序列化结果、App Server 消息和 renderer 请求在运行时验证前均不可信。TypeScript 类型不能代替边界验证。Renderer 到 main、main 到 daemon、daemon 到 App Server 使用彼此独立的协议和最小权限接口。

## 5. 进程生命周期与监督

Electron main 启动一个 Harness daemon。macOS/Linux 使用仅所有者可访问的 Unix domain socket，Windows 使用 named pipe。main 生成 256 位 CSPRNG 启动 capability，通过继承 FD 3 单次交给 daemon；该值不进入 argv、普通环境变量、日志、持久化或 renderer。继承 FD 4 只用于父进程存活检测。

V1 使用现有两个监督角色处理单一监督者故障：

- Electron main 意外退出而 daemon 仍存活时，daemon 从 FD 4 读取 EOF，原子进入 `QUIESCING`，关闭全部 spawn gate，再请求优雅中断和排空，终止已跟踪后代并退出。
- daemon 意外退出而 main 仍存活时，main 使用工作启用前记录的 kill-domain 标识终止 daemon 进程组及单独跟踪的 worker 或 PTY 组。
- Windows 在启用工作前把进程树加入不可 breakaway、带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object。
- 超过优雅关闭时限后，监督者按 graceful termination、`SIGTERM`、`SIGKILL` 的顺序升级。

同时失去两个监督者、操作系统崩溃、断电或故意逃逸进程组不属于 Unix 硬保证。重启后相关运行只能标记为 `interrupted` 或 `containment_unknown` 并等待核对，不能推断为完成，也不能自动恢复写操作。

macOS 首发的 daemon 运行时只接受位于当前用户私有目录中的绝对 Unix socket 路径，拒绝复用已存在端点，监听后将 socket 权限固定为 `0600`。启动 capability 必须从 FD 3 有界读取且在启动前完成规范校验；FD 4 的 EOF、错误或异常关闭触发一次保守排空。运行时按 `starting`、`listening`、`quiescing`、`closed` 转换，停止监听后先冲刷已排队响应，再在超时后销毁连接；库层不得直接退出进程。Electron main 的 spawn、独立进程组和升级终止策略在该 daemon 运行时之上实现。

macOS 的 Electron main 监督层在当前用户私有 runtime root 下创建随机 `0700` 目录，以独立 POSIX 进程组启动 daemon，固定 FD 3/FD 4 管道布局，并在 RPC hello 前验证 socket 所有者、`0600` 权限及 dev/inode。监督层必须显式接收并在 spawn 前验证一个绝对、可执行的 Codex CLI 路径；调用方参数不能覆盖 supervisor 拥有的 endpoint 或 Codex executable，实际 argv 只追加固定 `--endpoint` 与 `--codex-executable` 值，startup capability 仍只经 FD 3 传递。daemon 只有在精确 Codex 版本、App Server 初始化和完整模型目录均成功后才监听，因此 supervisor 默认 readiness deadline 为 30 秒，以覆盖 worker 默认 25 秒最坏启动窗口；调用方仍可在 60 秒上限内显式收紧。正常停止先请求 RPC 排空并关闭 watchdog 写端；宽限期后只对启动时记录的负 PGID 依次发送 `SIGTERM`、`SIGKILL`。daemon leader 意外退出不等价于进程域已清空，监督层仍检查同组后代；无法证明进程组消失时结果必须是 `containment_unknown`。endpoint 只在身份未变化时删除，随机目录只在为空且身份未变化时删除。监督层不自动发现或下载 Codex、不自动重启或重放请求，也不把底层 stderr、环境、路径或启动 capability 暴露给上层。

## 6. 领域模型

```text
Project
└── Task
    ├── Requirement Revisions
    ├── Persistent Plan Revisions
    ├── Task Nodes and Dependencies
    ├── Runs and Codex Thread Mappings
    ├── Route Decisions
    ├── Approvals
    └── Evidence
```

- `Project` 表示工作目录、仓库和项目级策略的集合。
- `Task` 表示用户目标及其当前权威状态。
- `Requirement Revision` 保存需求原文、规范化约束和验收条件的版本历史。
- `Plan Revision` 保存候选或已确认计划；计划步骤拥有稳定 ID。
- `Task Node` 是可调度、可验证的最小工作单元。
- `Dependency` 表示节点间的先决条件，并形成必须无环的 DAG。
- `Run` 表示一次具体执行尝试，关联 Codex thread/turn、路由、权限和结果。
- `Approval` 记录用户或策略对外部副作用的授权。
- `Evidence` 记录测试、构建、差异、人工确认或其他完成证明。

## 7. 任务节点与 DAG

Harness 而不是模型拥有节点和 DAG 的权威状态。高级模型可以提出拆分、顺序和依赖，但输出只能形成候选修订。Harness 必须验证节点 ID、依赖存在性、无环性、状态前置条件和权限约束后，才可原子提交。

节点至少区分 `pending`、`ready`、`running`、`blocked`、`succeeded`、`failed`、`interrupted` 和 `cancelled`。只有所有必要依赖满足且审批门禁通过的节点可以进入 `ready`。模型报告成功只结束执行尝试，节点必须在证据策略通过后才能进入 `succeeded`。

DAG 由 Harness 的计划规范化器和调度器共同产生：规范化器把需求与候选计划转换为稳定节点；调度器根据依赖和状态计算可运行集合。V1 串行领取一个 `ready` 节点，避免并发写冲突；后续并行能力必须引入资源锁、冲突域和确定性恢复设计。

节点/DAG 领域内核把已确认计划规范化为版本化 Graph Revision，并作为 `task.graph_committed` 事件与 Task 当前投影原子提交。每个节点保存稳定 UUID、来源计划步骤、描述、验收条件和前驱节点 UUID；Harness 要求所有已确认计划步骤被覆盖，拒绝重复、缺失引用、自依赖和环，并按节点输入顺序为并列根生成确定性拓扑序。Graph 提交时节点只能由 Harness 初始化为 `pending`，模型不能在 Graph 输入中声明 `ready`、`running` 或 `succeeded`。需求修订或新的 confirmed plan 会立即清除 active graph；仅 candidate plan 不会替换当前权威 DAG。Graph 历史保留在事件日志，当前投影只保存 active graph 和单调修订计数。节点状态流转、审批/证据门禁和调度器完成前，该内核不接入 daemon 运行路径。

## 8. 持久计划与上下文压缩恢复

结构化 Codex plan 事件保存为带版本的候选计划。Harness 持久化稳定步骤 ID、目标、未完成工作、约束、决定、依赖、验收条件和证据引用。文本中的待办列表可以被识别为候选计划，但在规范化和确认前不是权威状态。

任务与计划领域内核使用独立 `task.plan` 事件流保存 Task 创建、Requirement Revision 和 Plan Revision。Task 使用单调版本做事务内乐观并发校验；每个修订 UUID 同时作为对应事件 UUID，利用事件日志的全局唯一约束阻止修订 ID 被复用。Requirement Revision 保存用户原文、规范化目标、约束和验收条件，Plan Revision 区分 `candidate` 与 `confirmed` 并为每个步骤分配稳定 UUID；单项和单次修订的文本容量均受限，避免合法字段组合放大为无界投影。当前投影保留 active requirement、latest plan 和 last confirmed plan，完整修订历史留在不可变事件日志。需求修订会清除基于旧需求的 latest candidate，但保留 last confirmed plan 作为历史参照；新计划必须显式绑定当前 requirement revision。候选计划仍不能直接调度，必须由后续节点/DAG 规范化与确认门禁转换。

用户在任务中途补充或纠正需求时，Harness 先保存新的 Requirement Revision，并使旧 active graph 保守失效；不得继续领取旧节点，也不得把旧 TODO 静默改写为新需求。后续需求变更协调器负责比较旧需求、用户增量、当前计划和执行证据，保留语义未变节点的稳定 ID，为新增工作创建节点，把删除或改变验收条件的工作形成可审阅差异，并在重新验证后提交新的 Plan/Graph Revision。正在运行和已经成功的节点不能因文本修订自动继承有效性；具体中断、重新验证和确认策略作为独立能力交付。

需求变更调和内核以当前 Task version、Requirement、confirmed Plan 和 active Graph 的前驱 ID 作为乐观并发条件，在一个事件批次内提交新的 Requirement、confirmed Plan 与 Graph。Harness 从旧权威状态和新提案确定性派生 `preserved`、`added`、`removed`、计划相对顺序变化、节点依赖变化和需要重新验证的节点；调用方不能直接声明差异结果。复用步骤 ID 时标题、描述和验收条件必须逐项相同，复用节点 ID 时来源步骤与工作语义也必须逐项相同；语义变化必须表现为删除旧 ID 并创建新 ID。依赖边可以调整但必须进入差异记录，所有新图节点一律重新 materialize 为 `pending`，运行中的旧节点则拒绝切换并等待后续安全轮次边界处理。Task 当前投影保存与 active graph 对齐的 reconciliation 摘要，候选计划不清除它，Requirement、新 confirmed Plan 或独立 Graph 变更会清除它。三事件完整重试保持幂等，部分存在或任一校验失败整体回滚。该内核不判断自然语言语义、不直接接入 daemon，也不替代后续模型提案、审批、执行证据和安全中断能力。

每个安全轮次边界，Harness 为 Codex 构造最小恢复上下文，包括当前目标、活动需求修订、未完成节点、关键约束、已确认决定和所需证据。注入内容来自持久状态，而不是依赖旧对话的自然语言摘要。

恢复上下文内核从经过领域校验的 Task 当前投影确定性构造版本化胶囊。胶囊使用固定前缀和按键排序的规范 JSON，包含 Task/version、活动 Requirement、当前权威 confirmed Plan、尚不可执行的 candidate Plan、DAG 拓扑、未完成节点的完整工作语义、终态节点的最小摘要以及最近一次需求调和差异。它明确区分仅有需求、候选计划待确认、已确认计划待建图、活动 DAG 和活动 DAG 上存在新候选计划五种阶段；新 candidate Plan 不会抹掉仍绑定当前 Requirement 的 confirmed Plan，后者继续作为权威计划随胶囊恢复，前者只作为待确认提案。基于旧 Requirement 的 confirmed Plan 只作为历史修订 ID 暴露，不得成为当前执行依据。恢复文本不含时间戳，SHA-256 摘要和 Task/Requirement/Plan/Graph/Reconciliation 修订 ID 共同组成 freshness fence；发送前必须从最新投影重建并逐项比较，任何状态或内容变化都使旧胶囊失效。

V1 恢复胶囊只生成符合固定 App Server Schema 的单个 `turn/start` text input，并同时限制为最多 1,000,000 个 JavaScript 字符和 1 MiB UTF-8 字节；超限或关系不一致时保守失败，不截断 TODO、验收条件或未完成节点。该领域内核本身不调用 App Server、不改变出站方法白名单，也不建立 Task/Run 与 Codex thread/turn 的映射；这些连接属于后续安全轮次协调器。

外部 Harness 无法在模型同一轮发生上下文压缩后透明修改其正在进行的推理。V1 只保证在下一个安全轮次边界重新注入状态，并把压缩后、重新注入前产生的输出标记为需要重新验证。

安全轮次恢复门禁使用固定 Task/thread/turn 绑定，确定性归并经过适配器校验的生命周期信号。重复信号幂等，乱序的 started/completed/turn-summary 压缩事实只累加、不回退；错绑定和冲突终止状态保守失败，单个 turn 最多保存 1,024 个不同压缩 item 的观察事实。活动 turn 始终禁止恢复，任一 `completed`、`interrupted` 或 `failed` 终止边界都要求下一 turn 重新注入权威胶囊，而不是只在已观察到压缩时恢复；观察到任一压缩事实时，当前 turn 结果还必须标记为需要重新验证。准备下一轮时重新比较最新 Task 与恢复胶囊 freshness，只有终止边界、Task 绑定和新鲜胶囊同时成立才产生冻结的准备结果。该结果不是可长期缓存的授权，实际发送方仍必须在同一串行临界区立即复核并构造 `turn/start`。门禁内核本身不建立 Run 映射、不调用 App Server，也不把 turn 终止解释为节点证据通过。

在固定的 App Server 协议中，`thread/compact/start` 只表示开始压缩并立即返回空结果，实际生命周期通过 `turn/*`、`item/*` 和 `contextCompaction` item 事件观察；`turn/steer` 只会追加到仍在执行的当前 turn，不能作为压缩后的同轮修复通道。因此协调器必须等待 `turn/completed` 等可证明的安全边界，再把 freshness fence 仍有效的胶囊加入下一次 `turn/start`；不得承诺在正在执行的 turn 内透明修复。

## 9. 智能模型路由

Harness 只使用逻辑档位：

- `fast`：简单、低风险、边界清晰的任务。
- `standard`：一般代码编写、测试、局部重构和常规分析。
- `deep`：高层决策、复杂任务、系统性问题、高不确定性或高风险变更。

用户为每个档位配置实际 provider、model 和 reasoning effort。分类规则只输出逻辑档位，不能把具体模型名称硬编码到任务分类逻辑；每次 `RouteDecision` 还必须保存解析后的 provider、model、reasoning effort 和配置版本快照，以便审计与回放。

模型配置领域内核把用户输入规范化为版本化的完整三档映射。每个配置修订包含 UUID、正整数修订序号以及 `fast`、`standard`、`deep` 三个必填目标；每个目标严格包含 provider、model 和 reasoning effort。Harness 允许用户把多个逻辑档位映射到同一实际目标，不根据名称猜测模型强弱。解析逻辑只接受逻辑档位，并返回包含配置修订和实际目标的冻结快照；它不选择权限、不查询模型目录，也不在配置无效或不可用时静默回退。当前纯内核只证明单个对象结构合法；跨修订序号单调性由后续持久化提交门禁保证，账户可用性、模型目录、预算、限流和执行前复核属于后续策略与运行时门禁。

模型路由配置以稳定 profile ID 形成独立事件流，当前投影保存 profile version、活动配置和创建/更新时间。首次配置必须从 version 0 提交 revision 1；后续配置同时校验期望 profile version、前一 revision ID、严格加一的新 revision number 和不回退的事件时间。配置 revision ID 同时作为 event ID，完整相同重试幂等，stale fence、跳号或冲突内容整体回滚。路由 profile repository 接受 daemon 统一拥有的事件库并要求对应投影已经注册，不自行打开或关闭 SQLite；它本身不决定 Project 绑定、模型目录或 RouteDecision。

Project 通过独立的单调 binding version 引用一个活动路由 profile。首次绑定必须从 version 0 和空 previous profile 开始；改绑同时校验当前 binding version、前一 profile、目标 profile 的当前 version/config revision 以及不早于目标 profile 生效时间的事件时间，禁止对当前同一 profile 产生无意义的新绑定。绑定事件保存写入时观察到的 profile version 与 configuration revision 作为审计快照，但 profile 后续配置更新会自动成为该 Project 的当前配置，不要求重新绑定。历史 event ID 的完全一致重试先于当前 profile 和绑定检查，因此在 profile 更新或 Project 改绑后仍返回原历史结果；内容或 metadata 变化保持冲突。当前投影只保存每个 Project 的最新绑定，完整历史保留在事件日志。该 repository 复用统一 EventStore 并要求 profile 与 binding 投影均已注册；既有 binding 事件不因新增 Project registry 而改写，后续 coordinator 必须同时证明注册 Project、当前 Task 归属和活动 binding，不能只凭 binding 启动执行。

Project registry 以不可变注册事件建立 project version 1 的当前记录，并用独立 workspace owner 投影阻止完全相同的规范工作目录描述符被多个 Project 注册。工作目录明确保存 `macos`、`windows` 或 `linux` 平台与规范绝对路径，并固定标记为 identity 尚未验证；当前校验只有跨平台词法规范、长度和危险 Windows namespace 拒绝，绝不把字符串相同解释为 dev/inode、Windows file ID、符号链接、大小写或 Git 仓库 identity 相同。Project 修改、路径迁移和物理目录复核仍需后续独立能力。

Task 到 Project 的权威归属使用独立单调 ownership version。首次归属从 version 0 和空 previous Project 开始；改绑必须严格匹配当前 ownership version、前一 Project、当前 Task version 与目标 Project version，并禁止同 Project 的无意义改绑和事件时间回退。事件保存写入时观察到的 Task/Project version，历史 event ID 精确重试先于当前状态检查，因此 Task 后续修订或再次改绑后仍能返回原结果。当前归属按 Task 投影，同时维护 `projectId/taskId` 反向索引；改绑在同一事件事务内删除旧索引并写入新索引。该事实只供后续 coordinator 解析 Project，不授予目录访问、模型执行或其他权限。

影子路由内核使用固定策略版本和结构化特征快照确定性计算候选档位。简单且低复杂度、低歧义、局部、短步骤、少工具的任务可选择 `fast`；一般代码变更和常规分析至少选择 `standard`；架构决策、系统性诊断、高复杂度、跨系统、高歧义、长步骤或广泛工具任务选择 `deep`。安全敏感、数据迁移、并发敏感、公共 API 变更、生产影响、不可逆操作或权限边界变更中的任一信号都会把安全下限提升到 `deep`；最终档位只能取候选档位与安全下限中的较高者。输出保存冻结的输入特征、稳定理由码、配置修订与实际模型快照，并固定为 `shadow` 且不可执行。该纯内核不证明特征来源；模型或用户提供的低风险声明不能直接成为权威安全事实，来源协调、模型目录和执行前复核完成前不得接入运行路径。

权威 route feature snapshot 从经过领域校验的 Task 当前投影和恢复 freshness fence 确定性构造，并支持绑定当前 DAG 中的可选节点。snapshot 保存 Task 阶段、需求项数、当前权威与候选计划步骤数、图节点/依赖数和节点依赖闭包，不复制完整需求文本；Task、Requirement、Plan、Graph、Reconciliation 任一修订或内容摘要变化都会使旧 snapshot 失效。Task 结构提供 complexity、scope、ambiguity 和 estimated steps 基线；在任务类型与工具计划没有权威来源时，策略分别至少使用 `analysis` 和 `multiple`，避免未经证明地进入 `fast`。用户或模型 candidate 统一标记为 advisory，只能按字段强度保持或提高基线，不能降低；source 标签仅用于审计，不赋予权限。

安全信号严格区分“candidate 报告存在风险”和“尚未证明不存在风险”。candidate `true` 可以保守设置风险下限，candidate `false` 仍记录为 unresolved。虽然四类独立 observer 与品牌组合 coordinator 已可产生完整 shadow evidence，但 feature snapshot 尚未接入经过真实运行时 gate、workspace/runtime registry freshness 和安全 turn boundary 复核的权限计划、工作区分析、运行目标及外部副作用证据，因此仍固定 `deep` routing floor、`shadow` 和不可执行。snapshot decoder 会重建有效特征、provenance、未解决列表和 SHA-256 摘要；实际使用方仍必须在安全串行边界针对最新 Task 重新构造并比较。该能力不修改现有 RouteDecision 事件，解除 deep floor 必须由后续运行时证据 gate 和 evidence-to-feature PR 逐项完成。

Harness route evidence 使用 daemon authority session 内的进程品牌约束任务类型、完整工具计划和安全观察覆盖。authority 创建时固定 task classifier、tool planner 和安全 observer 的完整 policy version 集合，签发时每份观察必须精确匹配，避免同一 session 内用陈旧或任意策略标签冒充当前证据。证据同时绑定当前 Task recovery fence、可选活动 DAG 节点和不早于 Task 更新时间的观察时间；序列化、克隆、其他 authority session/policy set 或进程重启后的对象只能严格解码用于审计，不能恢复权威身份。工具广度只从去重的完整工具类别集合派生；工具计划缺失时保持 unresolved。安全负面证明使用固定双来源覆盖矩阵，任一来源报告风险即为 present，只有每个信号规定的全部 Harness observer 都明确报告 absent 时才为 absent，缺少任一来源均为 unresolved。`completeForRouting` 只表示本证据契约要求的观察覆盖完整，snapshot 仍固定 `shadow`、不可执行，也不会解除现有 feature snapshot 的 `deep` 下限；具体 observer、coordinator 与运行时复核必须后续独立交付。

封闭操作清单路由 observer 是首个具体证据观察器。daemon 信任边界内的调用方提供一份穷尽且有界的操作枚举，observer 在创建时固定 task classifier、tool planner 和 `operation_plan` policy version，并从同一清单确定性派生任务类型、去重且完整的工具类别计划，以及 `operation_plan` 负责的并发、迁移、不可逆、权限边界、生产影响和公共 API 六项安全观察。观察结果绑定当前 Task recovery fence、可选活动 DAG 节点、观察时间和进程内 observer session；严格解码后的 JSON 只可审计，不能恢复 WeakSet 权威品牌。该清单的“封闭”目前只是 observer 输入契约，尚未由 App Server 工具 gate 证明实际调用没有越界，因此本观察器不接入 route evidence authority、feature snapshot 或执行路径，单一来源的 `absent` 也不能替代双来源负面证明，更不能解除现有 `deep` 下限。

权限计划路由 observer 接受显式标记 `complete: true`、有界且可为空的固定 capability 请求列表，不允许调用方直接填写安全布尔值。它在创建时固定 `permission_plan` policy version，并从凭据访问、特权命令、权限边界和生产访问确定 security-sensitive，从两类显式不可逆 capability 确定不可逆操作，同时把权限边界 capability 独立报告为边界变更；普通工作区、命令、网络或外部写请求仍由权限系统单独决定批准级别，不自动等同于安全敏感。观察结果同样绑定 Task recovery fence、可选活动 DAG 节点、观察时间和进程内 observer session，clone 或严格解码不能恢复 WeakSet 品牌。`complete: true` 目前只是调用契约，尚未由操作 manifest、App Server approval 或实际工具 gate 强制，因此该 observer 不授予权限、不接入 route evidence authority 或执行路径，单一 `permission_plan` 的 `absent` 不能替代双来源负面证明，也不能解除 `deep` 下限。

工作区分析路由 observer 接受显式标记 `complete: true`、绑定不透明 workspace snapshot ID 与小写 SHA-256 digest、最多 512 项的固定 finding 集合，不允许调用方直接提交安全布尔值，也不保存路径或代码内容。它从共享可变状态和并发资源访问 finding 确定并发敏感，从数据库 schema 和持久数据重写 finding 确定迁移，从导出 API 和协议契约 finding 确定公共 API 变化，并从认证授权、凭据处理、密码学和安全边界 finding 确定安全敏感；快照绑定 Task recovery fence、可选活动 DAG 节点、观察时间、策略和进程内 observer session，严格解码可重算完整投影但不能恢复 WeakSet 品牌。本模块不读取文件系统、不重算 digest，也不证明上游分析确实穷尽或该 workspace snapshot 仍是 Project 当前工作区，因此 `complete: true` 和 `isCurrent` 都不能单独解决 workspace TOCTOU；在真实分析器、工作区快照注册表和安全边界 coordinator 落地前，它只提供 shadow 证据，不接入 route evidence authority 或执行路径，单一来源的 `absent` 不能解除 `deep` 下限。

运行目标路由 observer 接受显式标记 `complete: true`、绑定不透明 runtime inventory snapshot ID 与小写 SHA-256 digest、最多 128 项的固定目标集合，不允许调用方直接提交生产影响布尔值，也不保存目标名、主机、账号、URL、区域或部署 payload。目标环境使用固定类别：本地、临时、开发、测试和预发布报告非生产，生产数据面、生产控制面和客户生产环境报告 `productionImpact: present`；类别表达真实影响边界而不是显示名称，未来注册表必须把共享生产控制面的目标保守分类为生产控制面。快照绑定 Task recovery fence、可选活动 DAG 节点、观察时间、策略和进程内 observer session，严格解码可重算报告与摘要但不能恢复 WeakSet 品牌。本模块不发现目标、不重算 inventory digest，也不证明目标计划确实穷尽或 inventory 仍是 Project 当前状态；在目标注册表、运行时目标 gate 和安全边界 coordinator 落地前，它只提供 shadow 证据，不接入 route evidence authority 或执行路径，单一 `runtime_target` 的 `absent` 不能替代与 `operation_plan` 的双来源负面证明，也不能解除 `deep` 下限。

安全路由证据组合 coordinator 内部创建并持有四个 observer 与一个不对外暴露的 route evidence authority，以同一 coordinator session 和完整策略集合建立品牌链。调用方只能提交由这些内部 observer 创建的四份当前观察；coordinator 要求它们同时绑定当前 Task、同一可选节点和同一 recovery fence，并把四个观察时间的最大值作为 evidence 时间。任务分类、完整工具计划和 operation report 只来自 operation observer，另外三份 report 只能来自各自 observer；最终双来源聚合和 `completeForRouting` 仍由既有 authority 唯一计算，避免第二套矩阵。其他 coordinator、clone 或严格解码对象即使 session ID 与策略字符串相同也无法通过 WeakSet 品牌。该组合只证明观察来源、Task/节点当前性和策略一致，不证明上游 manifest、权限计划、工作区分析或目标 inventory 的完整性与新鲜度；完整 evidence 仍是 shadow、不可执行，不接入 feature snapshot、RouteDecision 或运行路径，也不能解除 `deep` 下限。

影子 RouteDecision 由 Harness 从命令特征和当前 profile 配置重新计算，调用方不能提交最终档位、理由或模型目标。记录绑定 decision、Task/version、可选节点、profile、配置 revision fence 和发生时间，以 `taskId/decisionId` 作为只增审计投影键；决策 decoder 会重新运行固定策略并核对全部派生字段。写入前先按 decision ID 查询：已存在时只接受所有业务字段、特征、配置 fence 和 metadata 均相同的历史重试，即使 profile 后来更新也返回原决策；不存在时必须证明期望配置仍是 profile 当前 revision，且 decision 时间不早于该 revision 的生效时间，过期 fence 或不可能的时间线不得创建新决策。记录始终保持 `shadow` 与不可执行，不成为权限或调度授权。

模型目录事实来自同一 Codex App Server worker 认证会话的完整 `model/list(includeHidden=true)` 分页结果，不能来自 Harness 内置的静态模型名单。目录快照绑定 daemon 分配的 snapshot ID、worker session ID、provider 和观察时间，不保存账号或凭据；第一页、游标链、末页闭合、模型与 effort 唯一性都必须验证，旧目录缺失 `inputModalities` 时按 App Server 兼容规则视为 `text` 与 `image`。只有当前 daemon 进程内经过完整分页工厂创建的冻结实例具有验证资格，序列化、克隆或进程重启不继承该资格。用户三档目标只按精确 provider、model 和 reasoning effort 检查，结果区分已观测可用、provider 未观测、model 不可用和 effort 不支持，不猜测名称、不自动回退。快照只证明该认证边界在该时间点的目录事实，固定不可授权执行。

daemon 的单 worker manager 为每个实际 worker 实例分配新的 session UUID，并以固定 `cursor: null`、`includeHidden: true`、`limit: 1000` 开始模型查询，最多闭合 128 页、累计 10,000 个模型和 64 MiB 重编码响应；重复游标、畸形响应、超预算、请求失败或目录工厂失败都会关闭整个 manager。初始加载和显式刷新只有在末页 `nextCursor: null` 且既有目录工厂完成全部模型约束后，才原子安装一个新 snapshot UUID；刷新开始、刷新失败、worker 断线或关闭开始时旧快照立即失去 current 资格。current 检查同时要求 manager ready、同一进程内快照对象身份和同一 worker session，clone、序列化、进程重启或新 manager 均不能继承。manager 不保存历史目录、不持久化快照、不自动重启，也不把目录可用解释为执行授权。

路由按以下顺序决策：

1. 确定性安全下限根据安全、迁移、并发、公共 API、生产影响、权限和不可逆性设置最低档位。
2. 结构化分类器根据复杂度、影响范围、系统性、歧义、工具需求和预计步骤数给出候选档位及理由。
3. 策略引擎应用用户预算、可用模型、速率限制和项目规则。
4. 运行时根据失败、反复修正、验证不通过或风险升级向更高档位迁移。
5. 每次决策记录输入特征、策略版本、配置版本、选择结果和解释，支持影子评估与回放。

模型档位和权限级别是独立决策。选择 `deep` 不会自动获得 shell、文件写入、网络或外部系统写权限；选择 `fast` 也不能绕过任务本身的安全下限。

## 10. 持久化设计

V1 使用 SQLite WAL，而不是把 Markdown 文件作为权威状态存储：

- 任务、节点、依赖、运行、审批和证据需要跨表事务与一致性约束。
- 崩溃恢复需要原子提交、WAL 和可重复查询。
- 调度器需要高效查询 `ready` 节点、活动运行和过期租约。
- Schema 版本和迁移比自由格式 Markdown 更适合机器状态演进。

Markdown 可作为面向用户的导出、快照或审阅格式，但不是调度和恢复的权威来源。Harness daemon 是 SQLite 的唯一写入者；其他进程只能通过版本化 RPC 访问状态。数据库不得保存明文凭据，provider 密钥进入操作系统钥匙串。

持久层采用事件日志与当前投影结合的方式：状态变更先以带序号事件持久化，再在同一事务中更新查询投影。恢复时校验事件连续性和投影版本；无法证明一致的运行进入保守中断状态。

事件日志内核运行在固定 Node 24 daemon 内，并通过窄封装使用内置 `node:sqlite`；该 API 在当前运行时仍标记为 experimental，因此运行时版本、driver 能力与 migration checksum 必须固定验证，领域层不得依赖 driver 类型。数据库使用 WAL、`synchronous=FULL`、foreign keys、`trusted_schema=OFF`、defensive mode、禁扩展和 exclusive locking mode。事件表全局序号严格递增且由 trigger 禁止更新或删除；event ID 的同内容重试幂等，不同内容冲突。数据库文件位于当前用户私有目录且固定为 `0600`，原始 SQL、路径、payload 和底层异常不得进入公开错误。事件 store 在任务投影与恢复门禁完成前保持未接入 daemon 启动路径。

投影使用注册时固定的名称、版本、事件选键函数和同步 reducer。新增事件、所有已注册投影状态和各自 checkpoint 必须在同一写事务内提交；任一 reducer 失败或返回非法结果时整体回滚。投影输入是递归冻结的事件与当前 JSON 状态，输出只允许 `keep`、`set` 或 `delete`，并经过与事件相同的有界 JSON 和 canonical 序列化检查；单个事件跨全部投影还共享 key 数和状态字节预算，防止放大写入。打开数据库时先以只读方式验证既有 migration 前缀、对应版本 schema、事件连续性和投影结构，再逐级迁移并处理恢复：缺失 checkpoint 全量回放、同版本落后 checkpoint 增量追赶、版本变化清空对应状态并全量重建，checkpoint 超前或状态来源序号越界则保守失败。未注册投影保留但不执行；Task 计划和当前路由领域投影已经具备确定性回放与共享恢复验证，Run、审批和证据投影及统一 daemon 启动协调器仍需后续交付，完成前 EventStore 继续不接入生产启动路径。

领域 repository 不得各自拥有同一数据库的独立 writer。Task 计划领域现在提供注入式 `TaskPlanRepository`，构造时先验证固定 Task 投影已注册，不拥有或关闭 EventStore；原有 `TaskPlanStore.open()` 只作为向后兼容的独立 owning wrapper，继续维持既有事件、投影和 `close()` 契约。Project registry、Task 归属、路由 profile、Project binding 和 RouteDecision repository 同样采用注入式事件库。编译产物 smoke 已证明这些领域可在一个 EventStore 中共同写入，并在重开后恢复 Task、Project、双向归属和路由事实；未来 daemon 存储协调器仍需把 Run、审批和证据投影一并注册并管理唯一数据库生命周期，当前组合证明不等于生产 coordinator 已接入。

影子 RouteDecision repository 同样使用注入式事件库，并要求路由 profile 与 decision 两个投影在写入前均已注册。事件只保存结构化特征和路由快照，不默认保存完整用户提示词；Task 范围查询只读取复合投影键。历史 event ID 精确查询先于当前 profile 检查，使配置更新后的完整重试仍保持幂等，同时不允许用历史配置创建新的 decision。

需要原子切换多个领域修订时，事件 store 提供有界批次追加：单批 1–16 个事件在事务前全部完成规范化、批内 event ID 唯一和 4 MiB 聚合 JSON 校验，再按输入顺序分配连续全局序号并逐事件更新投影。批次保留每事件投影预算，并额外限制整批最多 4,000 个投影 key 和 8 MiB 投影状态写入。幂等重试只接受整批事件均已存在、内容逐项相同且序号连续；部分存在、内容冲突、顺序异常或任一 reducer 失败都会回滚，禁止自动补写半个批次。该原语用于后续把 Requirement、confirmed Plan 和 Graph Revision 作为一个可恢复状态转换提交，不改变事件格式或 SQLite schema。

事件 store 还提供仅限 daemon 内部领域层使用的精确 event ID 查询。查询只接受规范 UUID，复用 event ID 唯一索引和统一事件解码器，返回深度冻结的完整事件或未命中；它不提供任意 SQL、模糊检索或 payload 搜索，也不进入 desktop/renderer 协议。该能力用于在当前投影已经前进后区分历史命令的完整幂等重试与使用过期 fence 的新写入。

## 11. Codex App Server 边界

Harness daemon 通过 stdio 上的 JSONL 拥有 Codex App Server worker。每条消息独占一行，stdout 只解析协议；stderr 单独采集并脱敏。连接必须先完成 `initialize`，再发送 `initialized`，之后才允许 thread、turn、模型查询、审批和事件处理。

适配器负责：

- 固定并记录兼容的 Codex CLI/App Server 版本与 Schema 摘要；
- 对请求、响应、通知和 server-initiated request 做穷尽分类；
- 关联请求 ID、thread、turn、任务节点和运行；
- 将审批请求转为 Harness 的权限流程；
- 对未知实验性方法默认关闭并安全诊断；
- 在断连、超时、重复或迟到消息下保持确定性失败语义。

App Server 的 `thread/compact/start` 只触发 Codex 侧压缩；Harness 的持久计划与轮次边界恢复是独立机制。V1 不向 renderer 暴露 `thread/shellCommand` 等可绕过 Harness 权限边界的原始能力。

适配器只把经过固定 Schema 最小验证的 `turn/started`、`turn/completed` 和 `contextCompaction` item 生命周期转换为恢复信号。信号仅暴露 thread/turn/item ID、终止状态和同一 turn 中的压缩 item ID，不携带完整模型输出、错误或其他 item 内容；`turn/completed` 同时扫描其最终 item 列表，作为单独 item 通知遗漏时的保守补偿。信号中的 `completed` 只表示 App Server turn 已到终止边界，不是 Task 节点已经通过证据验证。已知生命周期消息畸形时连接保守关闭，未知通知仍作为未解释事件保留。非压缩 item 不产生恢复信号，已弃用的 `thread/compacted` 也不能成为恢复权威。该层只验证单条消息，不处理重复、乱序、Task/Run 映射或下一轮注入决策。

首个适配器版本固定到 Codex CLI `0.146.0-alpha.9.2` 的非实验性完整 JSON Schema，并记录生成命令与 SHA-256。升级 Codex CLI 时必须重新生成 Schema、审阅协议差异并更新兼容性测试，不能把“新版本看起来可用”视为兼容。

V1 初始出站白名单只包含 `model/list`、`thread/start`、`thread/resume`、`thread/fork`、`thread/read`、`thread/list`、`thread/compact/start`、`turn/start`、`turn/steer` 和 `turn/interrupt`。初始化显式声明 `experimentalApi: false` 与 `requestAttestation: false`；`thread/shellCommand`、原始命令/文件接口、配置写入和账户写入不进入该边界。App Server 单条 JSONL 消息上限独立设为 16 MiB，不复用 desktop 到 daemon 的 1 MiB RPC 上限。未知通知可以作为未解释事件保留以便前向兼容，未知 server request 只能进入“不支持”分支，不能执行或自动批准。

daemon 内部的首个受控 App Server worker 在创建子进程前使用同一绝对 Codex executable 执行有界 `--version` 检查，并要求精确匹配 Schema manifest 固定的 `codex-cli 0.146.0-alpha.9.2`；通过后只以无 shell 的固定参数 `app-server --listen stdio:// --strict-config` 启动，继承 daemon 所在的 Electron kill domain。worker 分离并持续排空 stderr，但不向公开错误或事件暴露其内容；stdout 使用 16 MiB 上限、fatal UTF-8 和严格 adapter 做增量 JSONL 解析，完成一次 `initialize`/`initialized` 后才进入 ready。当前公开请求面刻意只包含只读 `model/list`，没有通用 method 入口；任意 server request、坏帧、截断、未知/重复响应、消费回调失败或请求超时都会关闭整个 worker，超时请求不自动重放。正常关闭先结束 stdin，随后只对精确 child PID 依次升级 `SIGTERM`、`SIGKILL` 并报告无法证明退出的 `containment_unknown`；由于尚未开放 turn，细粒度 worker 后代排空继续后置，外层 daemon 进程组仍是最终包含边界。

`DaemonRuntime` 可以显式接管一个已经 ready 且持有当前目录的 worker manager。接管后，任意 daemon 排空都会同时关闭 manager，daemon 的 `closed` 只有在端点清理和 worker 关闭均结束后才完成；manager 非预期关闭会以 `worker_failure` 停止监听并排空连接，worker 无法证明包含时报告 `worker_shutdown_failed`。实际 daemon CLI 固定接收 supervisor 追加的绝对 Codex executable，在 startup capability 和 parent 存活首次验证后创建 V1 `openai` manager，并在 manager ready/current 后才启动监听；parent 在 manager 的有界启动期间丢失时，CLI 在当前步骤返回后复核并关闭 manager，外层进程组 deadline 仍提供最终包含。worker/manager 启动错误只输出稳定 code，不回显路径、版本原文、stderr、模型、cursor 或服务端 message。库层无 manager 的最小 `DaemonRuntime` 入口只保留给隔离测试和未来显式组合；产品 CLI 不再把“无 worker listener”当作 readiness。当前 manager 不接入 SQLite、desktop RPC 或路由执行，在审批、工具 gate 和安全 turn coordinator 完成前不得开放 thread/turn。

## 12. Desktop 到 Harness 协议

main 与 daemon 使用换行分隔 JSON。每个连接的第一帧必须是严格的 `system.hello` bootstrap request；认证成功前，daemon 拒绝其他帧并关闭连接。认证先于 capability 和应用协议协商。

daemon 的连接核心与具体 Unix socket 或 named pipe 解耦：`@codex-harness/protocol` 统一提供双端共用的有界增量 JSONL 帧解码与严格 envelope parser，依次完成字节上限、换行边界和 fatal UTF-8 校验；连接状态机再执行首次 hello、启动 capability 认证、版本与 capability 协商以及 RPC 分发。`system.shutdown` 只产生一次请求排空的生命周期信号；连接层本身不直接终止进程。实际监听器、父进程存活检测和进程组监督在该连接核心之上实现。

Electron main 的 RPC 客户端只连接由其拥有的 daemon 本地端点，并使用启动 capability 完成首次 hello。客户端在请求发送前执行方法参数验证，在响应进入应用逻辑前执行角色、协议版本、请求 ID 和方法结果验证；未知或重复响应、坏帧、截断流与事件序号缺口都会保守关闭连接并拒绝全部待决请求。请求超时后的执行结果视为未知，客户端不得自动重放。daemon 的启动、kill domain、升级终止和受控重连由独立的进程监督层负责，不能混入 RPC 客户端。

握手后连接固定到精确匹配的应用协议版本。V1 wire version 为 `1`，应用协议版本为 `1.0`。应用层使用 `request`、`response`、`error` 和 `event` 四类 envelope；V1 只允许 main 发起 RPC。

关键约束：

- 启动 capability 是 256 位 CSPRNG 的规范、无填充 43 字符 base64url 编码，并使用常量时间比较。
- `streamId` 是 128 位 CSPRNG 的规范、无填充 22 字符 base64url 编码。
- 事件序号从 `1` 严格递增；重复事件可忽略，缺口触发重新同步，不同 `streamId` 必须从持久状态重建。
- 帧上限为 1 MiB UTF-8 字节，不含 LF 和可选 CR；解码必须使用 fatal UTF-8，并在未终止缓冲区超限前关闭连接。
- 请求 ID 在单连接的 in-flight 集合中唯一；断连请求不得自动重放，后续写 API 使用独立幂等键。
- 请求及请求参数使用严格 Schema；非内部响应和事件可接受同协议内新增的可选字段。
- `JsonValue` 验证限制最大深度 64、访问节点和待处理工作各 100,000，并拒绝循环、访问器、类实例、非有限数和其他非 JSON 值。
- `internal.error` 使用固定安全消息，只允许非敏感 correlation ID，禁止序列化堆栈、环境变量、请求参数、原始帧或凭据。

初始应用方法为 `system.health` 和 `system.shutdown`。`system.shutdown` 只请求经过认证的优雅排空，不向 renderer 提供直接终止进程能力。

## 13. Desktop 安全边界

- `contextIsolation` 开启，`nodeIntegration` 关闭，renderer sandbox 开启。
- Preload 只暴露白名单、窄类型 API，不暴露原始 `ipcRenderer`。
- main 对每个 IPC 请求再次验证来源、参数和当前窗口/任务权限。
- Renderer 资源使用严格 CSP；不加载任意远程代码。
- 文件选择、shell、剪贴板、通知和外部链接等系统能力由 main 单独审批。
- Provider 凭据保存在操作系统钥匙串，只在 daemon 需要时通过受控通道使用，不返回 renderer。

## 14. 审批、权限与证据

权限策略按操作风险而不是模型能力决定。只读操作、工作区写入、命令执行、网络、凭据访问和外部系统写入使用不同权限级别。审批记录包含请求摘要、作用域、过期时间、决策者和关联运行。

节点完成策略可以要求单元测试、类型检查、构建、差异核对、文件存在性、外部检查或人工确认。模型返回的自然语言结论只是候选结果；Harness 收集并验证证据后才提交节点完成。

## 15. 日志、隐私与诊断

Renderer、Electron main、Harness daemon 和每个 App Server worker 的日志彼此分离，也与协议流分离。日志使用结构化事件和 correlation ID，不记录启动 capability、provider 密钥、完整未信任帧、环境变量或未经策略允许的用户内容。

路由和调度记录保留可解释输入与结果，但避免把完整提示词作为默认遥测。V1 默认本地运行；任何外部遥测必须单独设计并由用户明确开启。

## 16. 交付顺序

运行时能力在依赖具备前保持关闭：

1. 工作区、协议契约与 CI：已由 PR #1 完成。
2. Codex App Server 适配器与受控 worker：固定 Schema/版本、严格 adapter、真实进程版本校验、stdio 初始化、只读 `model/list`、单 worker manager、完整目录分页、session freshness、daemon 排空绑定以及 Electron supervisor → daemon CLI 的真实启动接线已完成；application bootstrap/安装资源定位、认证状态、thread/turn、审批和工具 gate 待后续 PR。
3. daemon 生命周期与本地传输。
4. SQLite 事件日志和恢复原语。
5. 任务与持久计划状态。
6. 上下文压缩恢复。
7. 模型配置和影子路由：三档配置、确定性解析、配置 profile 持久化、Project active profile 绑定、Task → Project 权威归属、App Server 模型目录可用性检查、worker session 目录 freshness、带安全下限的影子分类、权威 Task 结构特征/freshness snapshot、进程内 route evidence 来源/覆盖契约、封闭操作清单、权限计划、工作区分析与运行目标四个 observer、品牌证据组合 coordinator 和 RouteDecision 审计已完成；其余运行时 manifest/权限计划/工作区分析/目标 inventory 新鲜度强制、evidence-to-feature 适配、执行前目录复核、daemon 路由 coordinator 和影子评估待后续 PR。
8. 串行调度。
9. 安全 Electron 桌面壳与任务 UI。
10. 审批、证据、运行恢复和打包门禁。
11. 端到端验证、故障注入、安全检查和发布。

每个 PR 只交付一个可独立验证的能力。依赖 PR 必须等待前置 PR 合并。若实现发现需要改变已批准范围、架构、依赖、关键技术选型、安全模型或跨 PR 契约，必须停止实现并更新 Proposal。

## 17. 全局验证标准

每个 PR 至少运行：

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:build
```

每个 PR 还必须完成与风险相称的安全、兼容性、集成和故障验证，并针对同一个 head SHA 连续完成两轮无新增可执行问题的审查。合并使用 squash，校验预期 head SHA；合并完成后确认目标提交，再删除远程和本地功能分支。
