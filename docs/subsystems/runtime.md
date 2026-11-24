# 执行层与运行机器

执行层（Execution Plane）把「在哪里运行编码引擎」从控制面解耦：每台机器实现统一的 `Machine` 抽象并登记进无锁 `MachineRegistry`，既保留单机合体的零开销本地执行（`LocalMachine`），也支持通过受认证出站 WebSocket 接入的远程宿主机（`RemoteMachine` / `vibevalley machine up`）与一次性容器沙箱（`SandboxMachine`）。执行拓扑与鉴权设计见[目标架构与部署拓扑](docs/architecture-topology.md)。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| `Machine` 抽象、`LocalMachine`、无锁 `MachineRegistry` 与 `(machineId, runtimeId)` 目标引用（`RuntimeRef`） | 各家引擎的进程协议与事件归约（[帮工](docs/subsystems/session.md)） |
| 控制面 L1 `MachineManager`、`MachineBus` 与 `/api/v1/machine/ws` 双向 WebSocket 总线 | 工单状态机、派活策略与并发配额（[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md)） |
| 远程机器守护进程 `vibevalley machine up`：本地引擎探测、断线续传缓冲、本地 `/mcp` 反向代理与独立 git worktree | 角色档案与引擎预设元数据（[档案和农机](docs/subsystems/agent.md)） |
| 临时容器沙箱抽象 `SandboxProvider`（Docker / Apple Containers）与 RAII `SandboxMachine` 生命周期清理 | 桌面外壳与移动端连接呈现（[客户端](docs/subsystems/app.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/protocol/src/contract/machine.rs` | 协议契约：`LOCAL_MACHINE_ID`（`"local"`）、`MachinePlatform`、`MachineStatus`、`MachineInfo`、`MachineRuntimeSummary`、`MachineWireFrame`（握手、心跳、清单、会话开关/输入/续接/事件/权限、`/mcp` 隧道、附件拉取、worktree 准备/清理）与 `machine.list` 端点 |
| `crates/runtime/src/machine.rs` | 运行时核心抽象：`Machine` trait、`LocalMachine`、`RuntimeRef`、`WorkdirSpec`/`WorkdirHandle`、基于 `ArcSwap` 的无锁 `MachineRegistry` 与变更广播 `MachineRegistryEvent` |
| `crates/runtime/src/sandbox.rs` | 容器沙箱层：`Secret` 脱敏令牌包装、`SandboxSpec`、`SandboxHandle`、`SandboxProvider` trait、`DockerSandboxProvider`、`AppleContainerSandboxProvider`、`MockSandboxProvider` 与析构自回收的 `SandboxMachine` |
| `crates/runtime/src/teardown_gate.rs` | 三态幂等析构门 `TeardownGate`（`ARMED -> TERMINATING -> TERMINATED`），串行化并发清理并在失败或 unwind 时安全回滚，受 `loom` 交错验证 |
| `crates/server/src/infra/machine/mod.rs`、`remote.rs` | 控制面 L1 `MachineManager`：维护 `Arc<MachineRegistry>`、将本地与远端机器投影为 `Fact::MachineChanged`/`Fact::MachineRemoved`、响应 `Hub::on_system_wake()` 立即探活、经 `AttachmentReadPort` 响应附件拉取；`remote.rs` 实现 `RemoteMachine`、`RemoteRuntime`、`RemoteSession` 与 `RemoteDispatchMeta` |
| `crates/server/src/transport/http/machine_ws.rs` | `GET /api/v1/machine/ws` 升级处理器：强制 Bearer 令牌校验与 `SCOPE_REMOTE_MACHINE`（`"remote:runtime"`）作用域隔离，不回落到本机默认身份；将 `MachineMcpRequest` 经 `Server::mcp()` 隧道转回控制面 |
| `crates/cli/src/domains/infra/machine.rs`、`crates/cli/src/machine_agent/` | CLI 命令 `vibevalley machine list` 与 `vibevalley machine up`；守护进程含持久化凭据 `machine-auth.json`（`0o600`）、断线续传会话环（`session.rs`）、基于 `axum::Router` + `axum::serve(...).with_graceful_shutdown(...)` 的本地临时 `/mcp` 代理（[mcp_proxy.rs](crates/cli/src/machine_agent/mcp_proxy.rs)，带 `DefaultBodyLimit` 与 `DropGuard`）与隔离 worktree 管理（`worktree.rs`） |
| `apps/mac/ui/features/runtime/RuntimesPage.tsx`、`machines.ts` | 工作台引擎页顶部「执行机器」条，合并 `SessionsSlice.machines` 与 `machine.list`，展示本地、远程与临时沙箱的状态、平台及可用引擎 |

## 模型和不变量

- **单机零开销默认（`local` 永远存在）**：`MachineManager::open` 启动时自动向 `MachineRegistry` 注册 `LocalMachine`（id 为 `"local"`、`here: true`）并写入 `Fact::MachineChanged`。未接入任何远程机器时，`RuntimeRef::local(runtime_id)` 直接在进程内解析本地 `oar::Registry`，不经过 WebSocket 或额外网络跳数。
- **严格作用域安全墙**：`GET /api/v1/machine/ws` 同时挂在回环门与远程门上，但永不回落到 `LocalOwner`。无令牌或吊销令牌一律返回 `401 Unauthorized`；非 `SCOPE_REMOTE_MACHINE`（`"remote:runtime"`）令牌（例如移动端或桌面端使用的 `remote:default`）一律返回 `403 Forbidden`。文本帧在进门处一次性解码为 `MachineWireFrame`。
- **凭据最小暴露与落盘权限**：`vibevalley machine up --code <配对码>` 通过 `POST /api/v1/remote/pair/exchange` 换取 `remote:runtime` 作用域令牌，非临时模式以 `0o600` 原子写入 `$VIBEVALLEY_HOME/machine-auth.json`；`--ephemeral` 模式不写凭据文件，退出时自动清理临时 worktree。所有内存中的令牌经 `Secret` 包装，在 `Debug`/`Display` 中脱敏。
- **断线无损续传（`session.attach`）与唤醒探活**：`machine_agent` 在本地为每个运行中的执行会话维护按单调 `seq` 索引的事件环与幂等输入记录；WebSocket 闪断重连后，控制面发送带 `afterSeq` 的 `MachineSessionAttach`，远端按序号补发错过的事件而不中止正在运行的引擎进程。macOS 休眠唤醒触发 `Hub::on_system_wake()`，控制面立即向已连远端发出 `MachinePing` 检测死连接。
- **本地 `/mcp` 隧道与附件按需拉取**：远程宿主机不向公网暴露端口；`machine_agent` 仅为运行中的会话在 `127.0.0.1:0` 临时起 Axum 回环代理 `LocalMcpProxy`（统一走 `axum::Router` 与 `CancellationToken::drop_guard()`，无裸 `TcpStream` 解析器），将引擎发出的 `/mcp` JSON-RPC 封装为 `MachineMcpRequest` 经同一条 WebSocket 隧道送回控制面的 `Server::mcp()`；附件内容经 `MachineAttachmentFetch` / `MachineAttachmentData` 按需拉取。
- **一次性容器沙箱 RAII 回收**：`SandboxMachine::launch(provider, &spec)` 按 `DockerSandboxProvider`（`docker`）或 `AppleContainerSandboxProvider`（macOS `container` CLI）拉起一次性容器并在其中运行 `vibevalley machine up --ephemeral`；一次性令牌一律通过子进程环境变量传入而非命令行参数，避免出现在 `ps` 参数表中；容器析构通过 `TeardownGate` 保证并发调用不重入且在 `teardown()` 或 `Drop` 时自动停止销毁。

## 怎么走

1. **配对与上线**：在控制面签发 `remote:runtime` 配对码，远程机器执行 `vibevalley machine up --server <URL> --code <CODE> --name <NAME>`，换领令牌后主动发起 `GET /api/v1/machine/ws` 连接并发送 `MachineHello` 与 `MachineInventory`。
2. **投影与选型**：控制面 `MachineManager` 登记 `RemoteMachine` 并提交 `Fact::MachineChanged` 刷新 `SessionsSlice.machines`；用户在工作台 `/runtimes` 查看在线机器，并可在角色设置（[AgentConfig.tsx](apps/mac/ui/features/agent/AgentConfig.tsx)）或新建任务（[NewIssue.tsx](apps/mac/ui/features/issue/views/NewIssue.tsx)）中选择目标 `machineId`（省略时由控制面路由）。
3. **派活与交付**：控制面按 `machineId` 从 `MachineRegistry` 解析目标机器；远程机器在独立 worktree 中完成修改并默认以推送分支 / PR 方式交付，事件与 `/mcp` 汇报沿 WebSocket 实时回传控制面。

## 怎么验证

- `cargo nextest run -p vibevalley-runtime`：`MachineRegistry` 无锁解析与事件广播、`DockerSandboxProvider` / `AppleContainerSandboxProvider` 命令构建、令牌环境变量隔离与 `SandboxMachine` `Drop` 回收测试。
- `cargo nextest run -p vibevalley-server`：`/api/v1/machine/ws` 鉴权与作用域拒绝（401 / 403）、`MachineManager` 握手/心跳/附件拉取/唤醒探活与 `RemoteMachine` 全链路测试。
- `cargo nextest run -p vibevalley-cli`：`vibevalley machine up` 守护进程、断线重连 `session.attach` 补放、`/mcp` 隧道与 `--scripted --once` 集成测试（[machine_agent.rs](crates/cli/tests/machine_agent.rs)）。
- `vp run mac:check`：[RuntimesPage.test.tsx](apps/mac/ui/features/runtime/RuntimesPage.test.tsx) 覆盖多机条合并渲染与实时状态更新。
