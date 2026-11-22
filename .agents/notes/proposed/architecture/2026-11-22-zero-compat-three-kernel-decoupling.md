# Agent Note: 零兼容三核正交解耦：去 Watch 化、领域无关 Agent 核与状态切片

Status: proposed

## Problem

随着桌面对话（`WorkspaceChat`）、直连对话（`DirectTalk`）、工单执行与像素场景演进，当前架构在运行时耦合出四组放大效应，且因为系统尚无外部历史用户包袱，继续保留兼容层只会永久锁定复杂度：

1. **执行核与上层领域因果倒置（Chat / Session 双轨）**：[session.rs](crates/protocol/src/contract/session.rs) 与 [workspace.rs](crates/server/src/modules/work/session/workspace.rs) 让 `WorkspaceChat` 伪装成 `AgentRole::Worker`（`Session::worker`），在全仓仅 2 处过滤之外泄漏进 `running_slots`、收件箱/巡查、像素画面、进度统计、`memory`、频道 `@` 补全与边栏等至少 10 处消费者；原生壳 [panes.rs](apps/mac/src/shell/panes.rs) 的 `close_tab` 不通知服务端清理 OAR 进程；运行态撕裂在 SQLite、`Ledger`、`records/<id>.jsonl` 与前端布局中；`Journal` 固定 `240` 截断、$O(N^2)$ 字符串拼接、`tool_detail` 缺字段与 100 ms 盲轮询；前端 `chatSession.ts` 与 `runs.ts` 并行维护 4 对重复计算，`ChatPane` 绕开 `Transport` 产生竞态，并与 GPUI 壳构成 7 跳闭环回绕。
2. **`collab/watch` 成为错位上帝中介**：`crates/server/src/modules/collab/watch/mod.rs` 将频道受众规则、工单开串/汇报、`issue.comment.create` 端点、跨界读删 `durable_store("issue.report")` 以及 `120 s` `await_reader` 同步等待揉入单一串行链路，导致一次慢速 `runtime.open` 阻塞全系统所有频道写入；`WakeBreaker` 与 `Reach::load` 为 0 生产调用死代码；`Hub::watch`（[lib.rs](crates/server/src/lib.rs)）的 5 路同步监听在通知链里直接写盘并重入 `Hub::apply`。
3. **全局单体 `SpaceState` 与多头推流**：[core.rs](crates/protocol/src/contract/core.rs) 把 11 个低相关领域及游戏皮肤 `FarmView`（plots / plays / 静态 `achievements`）焊进单一 `Mutex<Core>` 与全量 `StateFrame`（实测 `dense` 夹具紧凑约 73 KB），每次微小变更触发整包复制并驱动前端 `{ equals: false }` 全量信号；内部另有 5 套互不相通的推流引擎、4 套碎片输入队列，以及 UI 与 CLI 为 0 生产消费者的 [chord_space.rs](crates/server/src/chord_space.rs)（`/chord/ws` 与平行 `pi.inbox`）。

## Proposal

遵循**「零向后兼容、一次拆干净」**原则，将后端执行核、事件分发核与读侧投影核重构为严格无环的三核正交架构：

### 1. 核一：领域无关执行核（`AgentSession` + 统一持久 `Mailbox`）

- 将所有受管会话（工单执行、`WorkspaceChat`、`DirectTalk`）合流为单一领域无关的 `AgentSession`：`profile: Option`、`cwd: Option`、`ExecutionPolicy`（`DirectCwd` / `ManagedWorktree` / `ReadOnly`）、`controller: Option<SessionController>` 与 `bindings: Vec<ContextRef>`（0..N 强类型上下文句柄）。
- 执行核自身**不必须绑定任何上层领域**，可 0 绑定自由运行，也可被 `Issue` / `Channel` / `Artifact` / `PKM` 从外部反向挂载或运行中动态升级绑定；领域不变式（如工单必须用隔离 worktree）由各领域入口校验，不写死进执行核。
- 引入唯一的 SQLite 持久 `SessionMailbox`（合流原助手队列、`Board` 投递队列与直聊消息；支持未消费前撤回）与游标分页 `Journal`，全面支持统一 `resume` 与标签页关闭时确定性停机回收。

### 2. 核二：彻底取消 `collab/watch`，立起异步 `EventBus`

- 整体删除 `crates/server/src/modules/collab/watch/`、`Chat::await_reader`（`120 s` 阻塞）、`State::waiting` 及 0 生产调用的 `WakeBreaker` / `Reach::load`。
- **频道纯策略内聚**：将 `who_hears` 与 `hopLimit` / `cooldown` 规则收归 `modules/collab/channel`，仅依赖 `channel_participant` 等频道表（零依赖 `work/issue` 或 `work/session`）；提交消息时同步完成 < 1 ms 纯路由计算、立刻写出超限通知并记录持久 `pending` 投递后即返回，删除消息立即撤回未取走的 `pending` 投递。
- **异步无锁事件总线**：`Hub` 提供基于 Tokio 有界通道与协作停机信号（`&sink.stop` / `CancellationToken`）的异步 `EventBus`，取代同步 `Hub::watch`；`skin/game`、`team/memory`、`content/library`、`agent/runtime`、`work/issue` 与 `team/orchestrator` 均改为独立异步订阅者，禁止在消费回调中同步重入核心状态锁。
- **模块职责归位**：`issue.comment.create`、工单开串、单轮汇报与 `issue.report` 待发盒重放全部迁回 `work/issue`；席位维护与删频道守卫回归 `work/session`。

### 3. 核三：拆散 `SpaceState` 为域切片，删 `/api/v1/state` 与死推流

- 全栈（`crates/protocol`、`crates/core`、`crates/server`、`crates/cli`、`packages/protocol`、`apps/mac`、测试夹具与文档）直接将单体 `SpaceState` / `StateFrame` 拆为 5 个无锁竞争的域切片（`board`、`sessions`、`collab`、`inbox`、`ops`），**删除 `GET /api/v1/state` 与聚合兼容门面**。
- 将 `FarmView` 从核心工作台状态彻底剥离回 `modules/skin/game` 独立通道，将静态 `achievements` 目录改为一次性查询。
- 统一基于 `FrameFeed` Bounded-1 ACK 脏合并机制构建唯一 `SliceFeed` 底座，清零全仓无界 `flume`、500 ms 自旋轮询与多余 OS pump 线程；直接删除 0 生产消费者的 [chord_space.rs](crates/server/src/chord_space.rs) 与 `/chord/ws`（`pi.inbox` 孤岛），将真实运行时告警并入统一 `inbox` 切片。
- 前端合并 `chatSession.ts` 与 `runs.ts` 重复投影逻辑，统走 `Transport` 与按域订阅 `useSlice`，GPUI 壳直订 `sessions` 切片，彻底消除 7 跳闭环回绕与 `vvRev()` 全量 `repo.list`。

### 4. 分三波实施路线

- **PR-1（删除 `collab/watch` + 建异步 `EventBus` + 进程与 `Journal` 止血）**：删 `watch` 与 `await_reader`、上线 `EventBus` 替换 5 路同步 `Hub::watch`、职责归位 `channel` / `issue` / `session` / `orchestrator`；同步修复 `close_tab` 停机清理、`journal.rs` $O(N^2)$ 拼接 / `tool_detail` 字段 / 事件唤醒，以及 `workspace.rs` 静默错误。
- **PR-2（`AgentSession` 执行核去领域化 + 统一 `Mailbox` + 清除双轨与 7 跳回环）**：落地 0..N 绑定 `AgentSession`、SQLite `SessionMailbox` 与游标分页 `Journal`；消除 10 处伪 Worker 泄漏；收拢前端双实现、`ChatPane` 直连与 7 跳回绕。
- **PR-3（全栈切换 5 域切片 + 抽离 `FarmView` + 统一 `SliceFeed` + 删 `/api/v1/state` 与 `chord_space`）**：完成核心与客户端彻底瘦身解耦。

## Alternatives considered

### 为什么不在原处按 `is_workspace` 继续打过滤补丁？

仅靠在下游逐一加 `if !is_workspace(s)` 只能修掉当前已盘点的 10 处泄漏，新增消费者只要漏写过滤仍会复发，而且既无法统一生命周期与持久化，也无法消除 7 跳回绕与同步 `Watch` 阻塞。

### 为什么不引入封闭枚举 `SessionKind` 重分轨？

在 `Session` 契约中硬编码 `IssueWorker | WorkspaceChat | DirectTalk` 虽能区分现状场景，但本质仍是底层执行核反向依赖上层产品形态，无法表达「Agent 不必须绑定任何领域」或「自由对话运行中动态升级绑定工单」的能力。

### 为什么不保留 `collab/watch` 改异步、保留 `GET /api/v1/state` 做兼容门面？

`collab/watch` 本身只是为旧有同步调用关系修出的中介壳，拆掉后 `channel`（纯参与者派发策略）与 `issue` / `session` / `orchestrator`（`EventBus` 独立订阅者）自然构成严格无环 DAG；同时 `/api/v1/state` 全仓仅内部工作台与 4 个 CLI 文件消费，系统尚无外部历史用户，直接一次全栈切换可省去整层双写与聚合搬运代码。

## Acceptance criteria

- **PR-1**：仓库中不存在 `modules/collab/watch` 与 `Chat::await_reader`；`vp run rust:check` 与 `vp run sql:check` 全绿；新增集成测试证明一个通道内的慢 `runtime.open` 不再阻塞其他通道写话，`hub.apply` 内不触发任何同步重入写盘；关闭聊天页签后对应后台会话被停止；`Journal` 增量输出无 $O(N^2)$ 拷贝且无空闲 100 ms 盲轮询。
- **PR-2**：`WorkspaceChat` 不再以 `AgentRole::Worker` 伪装，`F1` 10 处消费泄漏均有回归测试锁死；自由桌面 `AgentSession` 支持无绑定启动、统一 `resume` 与运行中绑定升级为工单执行；`chatSession.ts` 双写代码与前端 ↔ GPUI 7 跳回环移除，`vp run protocol:check` 与 `vp run mac:check` 全绿。
- **PR-3**：单体 `StateFrame`、`/api/v1/state`、`chord_space` 与 `/chord/ws` 已移除，`FarmView` 脱离核心工作台推送通道且静态 `achievements` 不随高频帧下发；`vp run release:verify` 全绿并通过桌面端与 CLI 真机验收（见 [系统架构](docs/architecture.md) 与 [开发规范](docs/development.md)）。

## Risks

- **删 `await_reader` 后的因果保序细节**：若未将「< 1 ms 同步入 `pending` 投递与通知」和「异步唤醒进程」严格切分，刚发消息立刻删除时可能误投递。需保证频道提交时已完成投递入队与限流记账，撤销直接作用于 `pending` 状态行。
- **现有回归测试迁移**：[channel.rs](crates/server/tests/channel.rs) 中存在显式挂钩 `await_reader` 测崩溃恢复的回归测试，以及 [subagent_progress.rs](crates/server/tests/session/subagent_progress.rs) 中的 `240` 长度断言。变更时应保留同等级崩溃幂等恢复语义并在 PR 中通过 `## Regression` 说明。
- **PR-2 / PR-3 跨端全栈统切半径较大**：一次切换 `protocol` / `core` / `server` / `cli` / `apps/mac` 要求同步更新 `packages/protocol` 生成物与测试夹具，因此严格拆为三个可独立过全部检查的 PR 递进落地。
