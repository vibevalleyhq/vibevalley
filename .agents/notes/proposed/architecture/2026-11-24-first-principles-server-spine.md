# Agent Note: 第一性原理服务端脊柱重构（框架、目录、模板与彻底切换）

Status: proposed

## Problem

`crates/server` 在[模块边界](xtask/src/boundaries.rs)与并发棘轮（[xtask/src/ratchets.rs](xtask/src/ratchets.rs)）收敛之后，脊柱层仍存在四项违背第一性原理的结构债务：

1. **SQL 与 `SpaceState` 双写影子库**：业务模块写入 `ServerDb` 后仍须手工构造 `Vec<Fact>` 经 `Hub::apply` 镜像到内存 `Core`（`SpaceState`），启动时再由 15 条 SQL → `Fact` 水合路径重放恢复；字段定义与派生逻辑分散在协议形状、SQL 实体、启动水合器、`reduce` 与切片投影 5 处，极易漂移。
2. **4 套竞争因果机制**：域间通信并存直接方法调用、字符串键动态分发的 `Hub::invoke`、隐式异步扇出的 `EventBus::subscribe_transitions`，以及分散的 SQL outbox 表（`connector_outbox`、`channel_delivery`、`session_mailbox`），同一业务变化缺乏统一事务因果边界。
3. **星型中心 `Hub` + 运行时 `HashMap` + 9 个晚绑定槽位**：[crates/server/src/app/hub/mod.rs](crates/server/src/app/hub/mod.rs) 以 `Hub` 充当中心枢纽，维护 `handlers` 与 `typed_handlers` 两张运行时 `HashMap`、`openers` 订阅表，以及 9 个晚绑定 `attach_*` 槽位（`attach_mcp`、`attach_remote_auth`、`attach_machine_bus`、`attach_media_inputs`、`attach_voice`、`attach_speech_streams`、`attach_observer`、`attach_fault_gate`、`attach_host_debug`），使编译期静态装配退化为运行期动态查找。
4. **半同步 `block_on` 墙与双套停机机制**：服务端内部仍保留 `vibevalley_runtime::rt::block_on(` 同步阻塞边界（[xtask/src/ratchets.rs](xtask/src/ratchets.rs) 中 `SERVER_BLOCK_ON_CEILING = 73`）；生命周期管理分裂为 [crates/server/src/app/bootstrap.rs](crates/server/src/app/bootstrap.rs) 的 `ShutdownList`、`Hub::tasks`（`TaskTracker`）以及 `self_weak: OnceLock<Weak<Hub>>` 自持弱引用。

## Proposal

**明确拒绝渐进式或双模过渡桥**：不保留 `Hub` 与 `App` 并存，不搭建半 `SpaceState` / 半 `SliceProjector` 双模切换层。采用「一步到位彻底切换（Direct Cutover）」锁定目标四层框架、三级全单数目录布局与标准四规模块模板。

### 1. 四层服务端框架

- **`transport/`**：薄 Axum HTTP 网关（`transport/http`）与 GPUI 进程内桥（`transport/bridge`），只依赖 `Arc<dyn Server>`（`transport/api`），禁止导入任何业务域模块。
- **`app/door.rs`（`ServerDoor`）**：实现 `Server` trait，成为唯一跨边界调用门：
  - 基于 `crates/protocol` 生成的强类型 `EndpointId` 做编译期穷尽 `match` 分发，零运行时 `HashMap`、零字符串路由表。
  - 统一收拢 `CallerContext` RBAC 鉴权、`InvokeObserver` 与 `FaultGate`。
  - 通过不可变构造注入持有 6 个传输端口（`mcp`、`remote`、`machine`、`media_input`、`voice`、`speech`），彻底删除所有 `attach_*` 晚绑定槽位。
- **`app/mod.rs`（`App`）**：不可变的 `L0` → `L1` → `L2` → `L3` 自底向上组合根，全部字段严格采用**单数命名**：
  - 领域服务/存储：`db`、`setting`、`agent`、`repo`、`issue`、`session`、`pull`、`cron`、`workplace`、`channel`、`connector`、`voice`、`attachment`、`artifact`、`media`、`library`、`memory`、`orchestrator`、`tool`、`game`、`remote`、`machine`、`debug`
  - 运行时内核：`live`、`projector`、`runtime`
  - 进程内域间与 `ServerDoor` 下行调用均为直接强类型 `async fn`，零 JSON 往返编解码。
- **存储、瞬态与切片投影**：
  - `ServerDb`：SQLite / PostgreSQL 唯一持久化真源；写原语 `db.write` 返回 `(T, SliceMask)`。
  - 统一事务性 `Outbox`（`app/outbox.rs`）：与业务写入在同一数据库事务内落盘，替代分散的局部 outbox 表与 `EventBus` 隐式扇出。
  - `LiveOverlay`（`app/live.rs`）：仅承载不落盘的运行中会话流、心跳与 `FarmEffect` 突发特效，绝不充当影子数据库。
  - `SliceProjector` 与 `SliceFeed`（`app/slice.rs`）：依据 `SliceMask` 对脏切片做单航班（single-flight）合并重投影，调用 `crates/core` 纯函数与 `FarmFrame` 投影写入 `tokio::sync::watch<Arc<str>>`。
  - 单一 `Runtime`（`app/runtime.rs`）：集中持有 `CancellationToken`、`TaskTracker` 与唤醒信号，删除 `ShutdownList` 与 `self_weak`。

### 2. 三级全单数目录布局

- **`crates/server/src/app/`**：`{mod,bootstrap,door,slice,live,runtime,outbox,port,refusal}.rs` 与 `app/fake/`，彻底删除 `crates/server/src/app/hub/`。
- **`crates/server/src/db/`**：`{mod,error,column}.rs`、`db/entity/`（全面单数，替代原 `db/entities/`）与 `db/migration/`。
- **`crates/server/src/{work,team,collab,content,skin,infra,transport}/`**：模块目录与对外结构体全部采用单数命名（`IssueStore`、`SessionStore`、`AgentStore`、`RepoStore`、`CronStore`、`MemoryStore`、`ArtifactStore`、`AttachmentStore`、`Connector`、`MachineStore`、`RemoteStore` 等，见[命名规范](docs/style/naming.md)）；外部 HTTP `v1` URL 路径与 JSON 线缆契约保持不变。
- **`crates/core/src/`**：净化为纯领域规则与纯投影函数（`projection.rs`、`game.rs`、`status.rs`、`rules.rs`、`cron/`、`artifact/`、`collab/`），删除内存影子 `SpaceState` 与 CRUD `Fact` 镜像。

### 3. 标准四规领域模块模板

每个领域模块收敛为 `<domain>/<concept>/{mod.rs, store.rs, worker.rs (可选), test.rs}`，遵守四条铁律：

1. **单向下行与单数命名**：仅通过 `mod.rs` / `store.rs` 接收显式注入的下层强类型依赖与统一单数命名；严禁注入或回指 `App` 与 `ServerDoor`。
2. **单一落库与脏掩码投影**：状态写入只走 `db.write(|tx| ... -> (T, SliceMask))`（外部投递在同一事务写入 `Outbox`），提交后立即调用 `projector.mark_dirty(dirty)`；零 `hub.apply(Fact)`、零 `EventBus`、零启动水合。
3. **瞬态只进 `LiveOverlay`**：`FarmEffect` 与运行中会话实时步骤只写 `LiveOverlay`，绝不入库。
4. **端点统一声明与穷尽分发**：所有对外操作在 `crates/protocol` 声明，由 `app/door.rs` 的编译期穷尽 `match` 直派至对应模块方法。

### 4. 四步直接切换顺序

- **地基复用**：完成进行中的异步持久化事务与 `work` 域异步落库改造（`async-w1-durable-tx`，100% 复用，不返工）。
- **Step 1（`spine-w1-framework`）**：搭建 `crates/server/src/app/*` 四层框架、在 `crates/protocol` 生成编译期穷尽 `EndpointId` 枚举，并在 `crates/core` 落地无影子状态纯投影 `projection.rs`。
- **Step 2（`spine-w2-domains`）**：将 `work`、`team`、`skin`、`collab`、`content`、`infra` 全部域模块改写为标准四规模板与全单数命名，写入路径收敛至 `db.write` + `Outbox` + `projector.mark_dirty`。
- **Step 3（`spine-w3-cutover`）**：一次性切换 `bootstrap.rs` 至 `App` + `ServerDoor`；彻底删除 `app/hub/`、`SpaceState` 影子内存、CRUD `Fact` 镜像、`EventBus` 与 `ShutdownList`；接通 `transport/{api,http,bridge}`。
- **Step 4（`spine-w4-verify`）**：在 `xtask` 新增静态门禁（禁止 `Hub`、`EventBus`、`attach_*` 及复数服务/Store 命名，压低 `SERVER_BLOCK_ON_CEILING`）；将本方案沉淀进子系统文档并删除本 Note；跑通双库与全仓门禁。

## Alternatives considered

**渐进式 / 双模分阶段迁移**：在过渡期同时维护 `Hub` 兼容垫片、新旧双路由器以及半 `SpaceState` / 半 `SliceProjector` 桥接层。否决原因：双模桥梁需要额外编写大量一次性适配与双写校验代码，反而把字段漂移与两套因果链的复杂度放大一倍；服务端内部契约受[不留兼容](AGENTS.md#规矩)约束，直接切换成本更低且更安全。

**将 `Hub` 拆分为多个更小的子 `Hub`**：按域拆出 `BoardHub`、`CollabHub` 等继续保留内部路由与局部事件总线。否决原因：仍保留星型间接分发、动态注册表与 `attach_*` 晚绑定模型，无法从根上消除影子库与竞态因果链。

**引入 Linear / ElectricSQL 类客户端同步引擎**：在服务端之外引入通用局部同步协议与客户端全量复制库。否决原因：对于单工作区本机工作台过于沉重，且会破坏 `crates/core` 确定性任务状态机、收件箱及像素农场投影的纯函数测试能力。

## Acceptance criteria

- `xtask/src/ratchets.rs` 中 `SERVER_BLOCK_ON_CEILING` 降至接近 0（仅保留进程启动/同步宿主边界）。
- `crates/server` 零运行时 handler `HashMap`（`handlers` / `typed_handlers`）、零 `attach_*` 晚绑定槽位，`ServerDoor` 对 `EndpointId` 实现编译期穷尽 `match`。
- `crates/server` 全面落实单数命名，零 `Agents`、`Crons`、`Repos`、`Issues`、`Memories`、`Connectors` 等复数服务/Store 名，且由 `xtask` 静态检查持续守住。
- `crates/server/src/app/hub/`、`SpaceState` 影子内存库、CRUD `Fact` 镜像、`EventBus` 与 `ShutdownList` 全部删除。
- SQLite 与 PostgreSQL 14 双后端测试全绿；`make verify`、`make rust-loom`、`vp run mac:check`、`vp run mobile:check`、`vp run site:check` 与 `vp run deadcode` 全部通过。

## Risks

- **PostgreSQL 切片重投影查询延迟**：切掉内存 `SpaceState` 后，每次脏切片重投影需从数据库查询当域视图；通过合理索引、`SliceMask` 单航班合并去抖（coalescing）以及高频瞬态走 `LiveOverlay` 缓解。
- **像素农场 `FarmEffect` 动画时序**：特效不再随 `Core::apply` 同步产生而由 `LiveOverlay` 突发注入 `FarmFrame`；通过 CPU 像素场景确定性测试验证帧序列与时机不回退。
- **端到端兼容与回归门禁**：切换过程中须确保对外 HTTP `v1` 线缆契约、SSE `Last-Event-ID` 续读及 `scripts/release/regression.ts` 全流程回归稳定通过。
