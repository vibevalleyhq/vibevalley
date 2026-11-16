# Agent Note: 纯 Go 受管平台总架构、模块边界与四阶段演进路线

Status: proposed

## Problem

当前服务端（`apps/server`）、桌面壳（`apps/desktop` Electron + Node 24 + PGlite）、灵动岛（`apps/island` Swift）与终端助手（`apps/pty` Swift）横跨多种运行时与进程边界，在向多机托管与长时自治演进时面临四项结构瓶颈：

1. **执行环境与控制面耦合**：[帮工](docs/subsystems/session.md)进程、工作目录与状态折叠共处同一机器，尚未完成跨机物理隔离（参看 [拆出 apps/machine](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md)）；沙箱异常或重型构建易拖累主服务响应，且新会话首轮推理受本地环境准备阻塞。
2. **多运行时分发与内存负担重**：桌面版需捆绑 Electron、Node 24 与 PGlite，常驻内存达数百 MB；若在远端开发机或临时容器额外部署机器守护进程，依赖 Node 运行时与原生编译脚本阻碍单文件跨平台分发。
3. **第三方实验包上游破坏性变更频繁**：当前依赖的 [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) 与 [`@botiverse/oar`](https://github.com/botiverse/oar) 均处于高频非兼容演进期，缺少由本仓掌控的稳定存储表结构与线缆帧契约。
4. **缺少生产级自治护栏**：对比 [Claude Managed Agents 架构规范](https://platform.claude.com/docs/en/managed-agents/overview)，现有执行层尚缺会话花费硬熔断（[Session Budgets](https://platform.claude.com/docs/en/managed-agents/budgets)）、独立上下文验收裁判（[Define Outcomes](https://platform.claude.com/docs/en/managed-agents/define-outcomes)）、三态工具权限策略（[Permission Policies](https://platform.claude.com/docs/en/managed-agents/permission-policies)）、沙箱出站域名白名单及工作目录记性/技能双向同步（[Self-Hosted Sandboxes Memory](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory)）。

## Proposal

以单一 Go Module（要求 Go 1.27+，全程坚守 `CGO_ENABLED=0`）重写受管控制面、远程机器守护进程、业务域后端与混合桌面壳，保留 `apps/web`（Solid 2）作为跨宿主共用页面层。整套设计拆分为五份正交提案，本文定义顶层目的、终态指标、模块拓扑、四阶段演进路径与最终验收矩阵，其余四份子系统细节分别归属：

- 通信与增量状态层：[Go 版 Chord 状态增量同步与跨进程多路复用链路](.agents/notes/proposed/architecture/2026-11-16-go-chord-sync-and-link.md)
- 持久调度、安全与治理层：[Go 版 Durable 持久状态机、凭据代理与会话治理闭环](.agents/notes/proposed/architecture/2026-11-16-go-durable-vault-and-governance.md)
- 远程工作目录与农机适配层：[零密钥远程执行节点、Go 版 OAR 农机驱动与目录双向挂载](.agents/notes/proposed/architecture/2026-11-16-go-machine-oar-and-mounts.md)
- 业务域与双模桌面壳层：[VibeValley 全域纯 Go 收敛（笔记、Artifact）与 MyGo 双模桌面壳](.agents/notes/proposed/architecture/2026-11-16-go-vibevalley-domains-and-mygo-desktop.md)

## 最终目的与终态工程指标

系统建设的最终目的是交付一套**控制与执行物理解耦、单二进制零依赖分发、兼具云端隔离沙箱与本机自有农机订阅混编能力的 AI 原生研发工作台**（参考 [Managed Agents 解耦架构指南](https://harness-guide.com/guide/managed-agents-architecture/)）。一步到位的终态须满足六项硬指标：

| 维度 | 终态目标规格 | 技术支点 |
|---|---|---|
| **交付产物** | 单一 `go.mod` 编译出三个零 CGO 静态可执行文件：`vibe-server`（无头控制面与业务宿主）、`vibe-machine`（小于 15 MB 的零密钥远程执行守护）、`vibe-desktop`（内嵌控制面与本机执行器的桌面端）。 | [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite)、[`egoist/mygo`](https://github.com/egoist/mygo)、[`evanw/esbuild`](https://pkg.go.dev/github.com/evanw/esbuild/pkg/api) |
| **崩溃恢复与熔断** | 会话消息、状态文档、任务阶段与外部信号严格遵循「先原子落盘、再对外发布」；任意时刻遭遇 `SIGKILL` 重启后从最近检查点续跑，连续未推进检查点崩溃达 `restartLimit`（默认 5 次）自动熔断。 | 对标 [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) 显式阶段检查点 |
| **零空转挂起与预算刹车** | 等待人工确认、Webhook、定时唤醒、子会话结算或触发会话花费上限（`budget_reached`）时，会话转入落盘休眠态，占用 0 个活跃 Goroutine 与 0 个临时容器。 | `durable` 信号箱与 [Session Budgets](https://platform.claude.com/docs/en/managed-agents/budgets) 门控 |
| **零信任凭据与出站隔离** | 模型 API Key、Git 令牌与 MCP OAuth 凭据仅驻留于 `vibe-server` 的 `vault` 模块；`vibe-machine` 环境变量零长期密钥，出站流量经控制面代理核验 `allowed_hosts` 白名单并按单会话短期令牌代填凭据。 | [Decoupling Brain from Hands 安全实录](https://daily.dev/posts/decoupling-the-brain-from-the-hands-claude-managed-agents-part-1-of-4-anthropic-ps9ygs2dn) |
| **多端毫秒级增量同步** | 流式吐字与终端输出按 100 ms 节拍推内存视图、按 1,000 ms 窗口合并落盘；断网或慢消费经 `PendingOps` 在线折叠，超 10,000 条操作自动退化为全量窗口快照替换。 | 对标 [`@earendil-works/chord`](https://www.npmjs.com/package/@earendil-works/chord) 与 [`dat267/pier/chord`](https://pkg.go.dev/github.com/dat267/pier/chord) |
| **异构农机统一归因** | 内置多模型循环与外部编码 CLI（Claude Code、Codex、Qwen Code、Qoder 及 ACP 协议系农机）共享单调序号 `seq`、谱系路径 `agentPath`、扣减历史基线的增量花费核算与运行中跨网实时纠偏（`steer`）。 | 对标 [`botiverse/oar`](https://github.com/botiverse/oar) 与 [`attribution.md`](https://github.com/botiverse/oar/blob/main/docs/spec/attribution.md) |

## 模块划分与单向依赖不变量

Go 仓库采用具象执行与业务概念命名，禁用拟人化包名（如 `brain`、`hands`）与泛词包名（如 `common`、`utils`、`manager`）：

```text
go.mod
├── cmd/
│   ├── vibe-server/        # 无头服务端入口：装配 Store + Durable + Vault + 业务模块 + HTTP/WS 门
│   ├── vibe-machine/       # 远程执行节点入口：零密钥静态二进制，反向连接服务端，提供 Sandbox 与 OAR
│   └── vibe-desktop/       # MyGo 桌面壳入口：GPU 原生灵动岛窗口 + 系统 WebView 主工作台 + 内嵌全栈
├── pkg/                    # 零业务耦合公共协议库（严禁 import internal/*）
│   ├── chord/              # 双向多路复用 Link、严格 JSON Delta 折叠与单飞 Watch 订阅句柄
│   ├── contract/           # 跨进程类型化契约（ExecutionEnv、农机委派帧、前端共享视图结构体）
│   └── oar/                # 独立纯 Go 农机适配库（仅依赖标准库：Record 信封、ACP 底座、各 CLI 驱动）
└── internal/               # 核心引擎与 VibeValley 领域服务
    ├── durable/            # 持久化阶段任务引擎（6 表存储、组提交、Phase/Signal/Park、三级压缩、CodeMode）
    ├── vault/              # 信封加密凭据库、短期会话令牌签发、出站 HTTP/MCP 代填与域名白名单代理
    ├── machine/            # 工作目录 ExecutionEnv 实现、15 秒记性/技能双向同步、产出文件回收与 OAR 桥接
    └── domain/             # VibeValley 正交业务域（agent、memory、repo、channel、issue、watch、pkm、artifact、media、game）
```

CI 静态检查强制守住四条编译期依赖红线：

1. **严格单向分层**：依赖流向固定为 `cmd/*` → `internal/domain` → `internal/{durable,vault,machine}` → `pkg/contract` → `pkg/chord`，同层服务按确定拓扑单向注入，禁止循环引用。
2. **`vibe-machine` 纯净性门禁**：`go list -deps ./cmd/vibe-machine` 输出中严禁出现数据库驱动（`modernc.org/sqlite`、`pgx`）、模型商 SDK（`anthropic-sdk-go`、`openai-go`、`genai`）、`internal/durable`、`internal/vault` 或 [`egoist/mygo`](https://github.com/egoist/mygo)。
3. **`pkg/oar` 完全自治门禁**：`go list -deps ./pkg/oar/...` 仅允许出现 Go 标准库，确保离线回放测试套件零外部依赖独立运行。
4. **桌面壳外置门禁**：仅 `cmd/vibe-desktop` 允许引用 `github.com/egoist/mygo`，保证 Linux 容器与无头服务器构建零图形库依赖。

## 四阶段一步到位演进路径

Phase 1 首日即冻结终态包结构、`durable` 六张核心表与 `chord` 线缆帧头，后续阶段仅填充增量模块，零推翻返工：

1. **Phase 1：持久内核、增量链路与治理门控闭环（`pkg/chord` + `internal/durable` + `internal/vault` 基础）**
   - 落地 SQLite WAL 与 PostgreSQL 双兼容存储、单写者组提交、显式 `Phase`/`Signal`/`Park` 调度器、会话花费熔断（`BudgetGate`）与三态权限评估器（`PermissionEvaluator`），单机跑通流式推理与断电恢复。
2. **Phase 2：零密钥远程机器拆分与异构农机混编（`cmd/vibe-machine` + `pkg/oar`）**
   - 落地反向 WebSocket `Link` 拨号、首轮推理零阻塞按需租约绑定、`vault` 出站白名单代理、`.vibe/` 记性与技能目录 15 秒双向同步、`/outputs` 交付物自动回收，以及 Claude Code、Codex、通用 ACP 与 Qwen/Qoder 驱动。
3. **Phase 3：VibeValley 核心业务域迁入与双账本缝合（`internal/domain`）**
   - 裁撤原 TS `session` 执行内核，迁入 [`yuin/goldmark`](https://github.com/yuin/goldmark) 驱动的 `pkm`（含 FTS5 `trigram` 与向量混合检索）、内嵌原生 [`esbuild`](https://pkg.go.dev/github.com/evanw/esbuild/pkg/api) 自愈编译的 `artifact`、以及 `channel`、`issue`（对接 `onYield` 独立验收裁判）与 `watch`（三道唤醒刹车）。
4. **Phase 4：MyGo 双模桌面壳合体与高阶自治收口（`cmd/vibe-desktop` + `Dreams` + `CodeMode`）**
   - 用 [`egoist/mygo`](https://github.com/egoist/mygo) 替换 Electron、`apps/island` 与 `apps/pty`，实现 GPU 原生灵动岛秒批弹窗与 `apps/web` WebView 进程内直连；上线后台离线记性蒸馏（对标 [Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)）与 [`dop251/goja`](https://github.com/dop251/goja) 确定性重放 `CodeMode`。

## Alternatives considered

- **维持现有 TypeScript 服务端，仅把机器守护拆为 TS 子应用**：仍需在每台用户开发机与沙箱容器部署 Node 24 与大量 npm 依赖，桌面版无法摆脱 Electron + PGlite 的数百 MB 内存开销，且高并发文件索引与多进程管控不及 Go 原生稳健。
- **保留一半 Hono 业务服务端，仅把 `Session` 迁往 Go**：当 `Session`、农机驱动、`Vault`、[笔记](docs/subsystems/pkm.md)与 [Artifact](docs/subsystems/artifact.md) 均进入 Go 后，TS 服务端仅剩薄 `Channel` 与 `Issue` 表；同时维护两套服务端运行时、两套数据库连接池与跨进程内部回调的复杂度高于统一收敛至纯 Go 后端。
- **采用 Rust 重写全套后端与桌面壳**：Rust 编译周期长，且缺少原生进程内 `esbuild` Go API 与零 CGO 纯编译型跨平台桌面双模框架，迭代业务域的速度不及 Go。

## Acceptance criteria

上线切换并退役旧 TS 服务端前，须全部通过以下 6 项自动化端到端验收门禁：

1. **断电持久恢复门禁（Durability Chaos）**：在模型流式吐字、工具执行与上下文压缩三处随机注入 10 次 `SIGKILL` 并重启 `vibe-server`；事务零损坏，同 `requestId` 重试零重复执行，连续 5 次未推进检查点崩溃精确停在 `restart_limit` 熔断态。
2. **零空转挂起、花费熔断与独立裁判门禁（Governance & Outcomes）**：设置花费上限触发跨线后，当轮请求跑完立即转入 `budget_reached` 闲置态且活跃协程归零，调高额度后无缝恢复；配置 `Rubric` 验收标准的工单在帮工交卷时自动触发独立上下文裁判会话，未达标项自动打回重修直至通过或达轮次上限。
3. **控制与执行解耦门禁（Sandbox Decoupling）**：无在线 `vibe-machine` 时纯对话首字响应延迟不受阻塞；工具执行中途强杀容器不波及 `vibe-server` 存活，按重放策略向模型返回半截输出与 `interrupted` 诊断。
4. **零信任凭据与出站白名单门禁（Zero-Trust & Egress）**：在 `vibe-machine` 内扫描环境变量、`/proc` 与临时文件均无法提取原始模型密钥或长期令牌；访问非 `allowed_hosts` 外部域名被控制面代理硬性阻断，三态权限 `auto` 模式下的高危命令硬拒不可被客户端绕过。
5. **增量同步与目录挂载收敛门禁（Delta & Mount Sync）**：12,000 条高频变更下断线重连客户端自动收到根替换快照并与在线端状态字节级一致；工作目录 `.vibe/memory/` 内的文件修改在 15 秒周期与回合结束时精确同步回笔记/记性存储并保留不可变历史版本，`/outputs` 产物自动入库生成 Artifact 卡片。
6. **异构农机与双模桌面门禁（OAR & MyGo Desktop）**：单次工单内并行调度 Claude Code、Codex 与 ACP 农机，Resume 基线花费扣减零重算、运行中 `steer` 实时穿透；`vibe-desktop` 空闲 CPU 占用为 0%，灵动岛原生 GPU 窗口瞬时响应 `always_ask` 权限审批并与主 WebView 页面状态实时同步。

## Risks

- **Go 与前端 Solid 2 跨语言契约漂移**：脱离同构 TS 后，手写两套类型极易失步；须从 `pkg/contract` 的 Go 结构体单向生成前端 TypeScript 类型与 Zod 校验器，纳入 CI 门禁。
- **MyGo 与 Go 1.27 版本前沿性风险**：[`egoist/mygo`](https://github.com/egoist/mygo) 处于 `0.9.x` 活跃演进阶段；须在 `go.mod` 锁定精确提交版本，并将所有 GUI 调用严格隔离在 `cmd/vibe-desktop` 壳层内。
