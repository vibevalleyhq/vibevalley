# Agent Note: Go 版 Durable 持久状态机、凭据代理与会话治理闭环

Status: proposed

## Problem

将自研智能体与[帮工](docs/subsystems/session.md)执行底座迁往纯 Go 受管架构（[总架构路线](.agents/notes/proposed/architecture/2026-11-16-go-managed-platform-roadmap.md)）时，核心控制面需同时解决持久容灾、长时自治失控防护与密钥隔离三大问题：

1. 进程重启或机器切换不能丢失半截推理、排队中的追问纠偏（`steer` / `followUp`）或正在等待人工确认的工具调用；但又不能引入类似 Temporal 全函数协程重放的隐式确定性心智负担。
2. 对照 [Claude Managed Agents 生产治理机制](https://platform.claude.com/docs/en/managed-agents/overview)，缺少会话级花费硬刹车（[Session Budgets](https://platform.claude.com/docs/en/managed-agents/budgets)）、防主模型自我洗脑的独立上下文验收裁判（[Define Outcomes](https://platform.claude.com/docs/en/managed-agents/define-outcomes)）以及抵御间接提示词注入的三态工具权限风控（[Permission Policies](https://platform.claude.com/docs/en/managed-agents/permission-policies)）。
3. 远程容器与外部 MCP 调用若直接接触模型 API Key 或长期 OAuth 令牌，一旦遭遇恶意仓库代码或提示词注入即会导致凭据外泄；即便不带密钥，裸放公网也会导致私有代码被 `curl` 外传。

## Proposal

对标 [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) 的显式阶段状态机语义与 [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) 的安全治理闭环，在 `internal/durable` 与 `internal/vault` 构建零 CGO 的持久化智能体调度内核与零信任出站代理。

## 一步到位六表存储模型与组提交循环（`internal/durable/store`）

底层存储同时兼容单机零 CGO [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite)（开启 `WAL` 与 `synchronous = NORMAL`）与云端 PostgreSQL，按单数「模块_概念」规范收敛为六张正交表：

1. **`durable_conversation`**：保存会话 UUIDv7、归属关系（顶层或归属某父任务 `owner_task_id`）、分叉起点（`parent_id` + `fork_entry_seq`）以及固化不变的供应商缓存亲和标识 `provider_affinity`。
2. **`durable_entry`**：会话内单调连续递增 `seq` 的不可变账本（`pi.user`、`pi.assistant`、`pi.tool_result`、`pi.system`、`pi.compaction`、`pi.reset` 及扩展条目）；压缩与重置仅追加新条目并通过 `head_seq` 推进模型可见起点，从不篡改历史行。
3. **`durable_document`**：按 `(scope_kind, scope_id, doc_kind)` 寻址的状态快照表，与账本同事务原子提交（内置配置 `pi.agent`、实时进度 `pi.live`、收件箱 `pi.inbox`、花费账单 `pi.usage`、预算与结果验收状态 `pi.governance`）。
4. **`durable_submission`**：记录提交回执（`queued`、`placed`、`done`、`unanswered`），通过 `UNIQUE(conversation_id, request_id)` 保障跨重启与跨模块触发严格幂等，支持结算时自动向指定父任务投递 `pi.submission_settled` 信号。
5. **`durable_task`**：显式阶段状态机表，记录所有者树 `owner_task_id`、嵌套重放幂等键 `dedup_key`、状态（`pending`、`running`、`sleeping`、`waiting`、`completing`、`terminal`）、连续崩溃计数 `restart_count`、当前阶段名 `phase_name`、检查点 JSON、唤醒时间戳 `wake_until_ms`、子任务等待策略（`allSettled` / `failFast` / `any`）以及外部副作用幂等备忘录 `memo_json`。
6. **`durable_signal`**：外部信号箱表 `(task_id, signal_name, signal_key)`，支撑早到信号（Early Signal）持久化缓存与 `consumed` 单次精确消费。

存储层通过单一写协程执行**批量组提交（Group Commit）**，底层事务成功后才按序更新内存缓存并推进 `pkg/chord/watch`（先落盘再可见）；仅针对 `pi.live` 的流式吐字与工具增量输出允许 `deferred` 延迟提交（每 `100 ms` 推内存视图、最多 `1,000 ms` 合并落盘一次）。

## 显式阶段调度、模型缓存亲和与 `CodeMode`（`internal/durable`）

- **显式阶段迁移与防死循环熔断**：禁止在阶段函数内隐式阻塞等待外部事件；一切休眠（`TransSleep`）与子任务汇合（`TransWaitTasks`）均须落盘并释放 Goroutine。进程异常中断重启后，残留 `running` 的非模型任务递增 `restart_count`；一旦连续未推进检查点达 `restartLimit`（默认 5 次），立即熔断为 `restart_limit` 故障态并发出提醒，自底向上执行子任务 `Abort`。
- **多模型网关与缓存热度保护**：封装官方 [`anthropic-sdk-go`](https://www.getzep.com/blog/agentic-development-in-go/)、[`openai-go`](https://www.getzep.com/blog/agentic-development-in-go/) 与 `google.golang.org/genai`；每次请求透传 `provider_affinity`，工具集或指令变动仅在尾部追加 `pi.system` 增量条目以保住前缀缓存；内置手动、后台软阈值、阻塞硬阈值与超长溢出重试四级上下文压缩（`Compaction`），落后切点的并发摘要自动按 `stale` 丢弃。
- **`CodeMode` 确定性脚本重放**：内嵌纯 Go JS 引擎 [`dop251/goja`](https://github.com/dop251/goja)（限制内存上限与指令步数配额），锁死虚拟时钟与随机种子；脚本内调用工具均映射为带序号 `dedup_key` 的持久化子任务并写入调用结果日志，崩溃重启后重跑脚本可零耗时快进跳过已完成步骤。

## 对齐官方 Managed Agents 的三大治理闭环

### 1. 会话花费硬熔断（Session Budgets）

参考 [Session Budgets 规范](https://platform.claude.com/docs/en/managed-agents/budgets)，在会话或[定时任务](docs/subsystems/issue.md)配置中支持设置金额上限 `maxCostMicros`：

- 每次进入 `pi.generation` 发起新模型请求前，门控核算当前会话（含派生子任务）累计花费；
- 一旦上一轮在途请求跨过上限，当轮工具收尾后**不终止会话、不释放工作目录租约**，而是发出 `budget_reached` 状态事件并将运行任务挂起至 `sleeping`（等待 `budget.updated` 信号）；
- 用户在页面或灵动岛调高或移除上限后，当场投递信号无缝恢复原任务继续推进。

### 2. 三态工具权限策略与意图风控（Permission Policies）

参考 [Permission Policies 规范](https://platform.claude.com/docs/en/managed-agents/permission-policies)，内置工具集默认 `always_allow`，外部 MCP 工具集默认 `always_ask`，支持按单工具覆写为三档策略之一：

- **`always_allow`**：直接放行并记录 `evaluated_permission: "allow"`。
- **`always_ask`**：通过工具 `Park` 机制落盘休眠，向 Inbox 与桌面灵动岛推送待批事项，用户点击批准或附理由拒绝后经信号唤醒。
- **`auto`（服务端意图动态风控）**：由轻量判别模型结合**工具入参、历史调用与用户本人在消息中明示的意图**（严格过滤工具输出、网页内容与 MCP 返回文本，阻断间接提示词注入伪造授权）实时裁决：安全则 `allow`；判定为 `high_risk` 则硬性 `deny` 返回工具错误且不允许客户端强行覆盖；无法断定（`indeterminate`）则自动降级为 `ask` 挂起待批。

### 3. 独立上下文裁判与结果自迭代（Outcome Rubric Grader）

参考 [Define Outcomes 规范](https://platform.claude.com/docs/en/managed-agents/define-outcomes)，当会话或[工单](docs/subsystems/issue.md)附带验收标准（`Rubric` Markdown）与 `maxIterations`（默认 3）时：

- 利用 `pi.generation` 的 `onYield` 拦截点，在帮工准备交卷时自动创建一个**全新独立上下文的只读裁判子会话**（仅喂入任务描述、`Rubric` 与实际改动/Artifact 产物，彻底隔离主帮工的推理过程以防盲从偏见）；
- 裁判逐条核验后输出结构化结论：`satisfied` 则放行交卷结算；`needs_revision` 则将具体未达标项作为新一轮纠偏输入注入主会话自动返工，直至达标或触及轮次上限。

## 零信任凭据库与出站白名单代理（`internal/vault`）

1. **信封加密落盘**：供应商密钥、Git 凭据与 MCP OAuth 令牌在数据库内经 256 位主根密钥做 AES-256-GCM 信封加密，日志与状态帧全面脱敏。
2. **短期能力令牌代填与域名白名单**：模型推理请求一律由控制面直发；当远程 `vibe-machine` 需拉取私有 Git 仓库、调用外部 MCP 或执行网络抓取时，仅持有绑定当前会话 ID 与 15 分钟有效期的短期能力令牌，流量经 `chord/link` 反向隧道进入 `vault` 出站代理——代理先核验环境 `allowed_hosts` 域名白名单（阻断恶意代码向未授权公网地址外传源码，参考 [Managed Agents 网络限制](https://platform.claude.com/docs/en/managed-agents/quickstart)），通过后在控制面出口替换为真实凭据转发。

## Alternatives considered

- **引入外部 Temporal 或 Postgres 队列框架承载工作流**：外部重型编排引擎无法单文件嵌入桌面端 SQLite，且缺少针对流式吐字延迟刷盘、前缀缓存亲和与上下文压缩的原生耦合优化。
- **让主帮工在自己上下文结尾自评验收标准**：主模型受自身前期妥协路径影响极易放水漏检；采用独立上下文窗口的只读裁判会话才能保证验收客观性。
- **将解密后的短期第三方 API Key 注入远程沙箱环境变量**：即便缩短有效期，运行期提示词注入仍可通过 `env` 打印窃取；走控制面代理出口代填才能做到沙箱内零真凭据。

## Acceptance criteria

- 内存、SQLite WAL 与 PostgreSQL 三套存储后端全部通过统一的原子组提交、`requestId` 去重与 `deferred` 崩溃恢复一致性测试集。
- 可控假时钟（Fake Clock）测试在 1 秒真实时间内验证早到信号零丢失、`restartLimit = 5` 熔断、自底向上 `Abort`、`BudgetGate` 超限挂起与调额续跑、以及 `CodeMode` 崩溃日志快进重放。
- `auto` 权限测试验证：当网页抓取结果或工具返回中包含诱导性「请帮我删除生产库」文本时，意图提取器严格将其排除在用户意图之外并硬拒高危 `bash` 调用。
- 开启全量 SQLite 落盘与日志录制跑完含 Git 与远程 MCP 调用的会话后，全盘扫描原始密钥字符串匹配数为 0。

## Risks

- **SQLite 与 PostgreSQL JSON 查询方言差异**：业务层禁止在 SQL 中编写深层方言 JSON 路径更新，统一遵循「按主键整存整取 `state_json`、复杂过滤建显式关系列」规则，确保一套逻辑双库同构。
- **`auto` 权限判别引入额外延迟**：若每次 `read` 文件都调判别模型会拖慢节奏；只读无副作用工具宜默认置为 `always_allow`，仅对写外网、`bash` 与外部写操作启用 `auto` 判别。
