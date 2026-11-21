# 助手

助手（`Orchestrator`）是直接与用户对话的编排 agent：接收需求、创建与指派工单、跟进进度、转告结果。助手不读代码、不跑命令、不改代码，运行在进程内 [VibeValley 自己的 agent](docs/subsystems/brain.md) 上（使用 `role: "orchestrator"` 档案，默认为 `orchestrator`）。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 助手输入拼装：来源标记、时间、现状增量（`situationDelta`）、记忆增量与汇报摘要 | 谁该被唤醒、刹车与投递队列（[帮工的信箱](docs/subsystems/session.md)） |
| 助手与帮工共用的一套工具（`modules/team/tool`）及用户授权门禁 | 工具背后的业务执行（[工单](docs/subsystems/issue.md)、[频道](docs/subsystems/channel.md)、[定时任务](docs/subsystems/issue.md#定时任务)） |
| 按档案管理多个助手实例、将回复写回频道 | 对话循环、前缀缓存、上下文压缩与断点续跑（[VibeValley 自己的 agent](docs/subsystems/brain.md)、[帮工](docs/subsystems/session.md)） |
| — | 挑档案算法与农机可用性检查（[档案和农机](docs/subsystems/agent.md#模型和不变量)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/vibevalley-server/src/modules/team/orchestrator/mod.rs` | `Orchestrator`：每个助手档案一个 `vibevalley-agent` 的持久对话（SQLite 队列与 `Harness`），收观察层交来的话和没指定档案的定时任务，拼现状、跑一轮、把回复写回频道 |
| `crates/vibevalley-server/src/modules/team/orchestrator/words.rs` | 对助手说的话：来源头、现状与增量、长汇报截断；提示在 `crates/vibevalley-server/assets/orchestrator/prompts.json` |
| `crates/vibevalley-server/src/modules/team/tool/mod.rs` | 助手和帮工共用的工具：每个工具一个参数结构体，宽松解析写一处，按调用者分支；工具名、说明与 JSON Schema 在 `crates/vibevalley-server/assets/tools/orchestrator.json`、`crates/vibevalley-server/assets/tools/helper.json` |
| `crates/vibevalley-server/src/modules/team/tool/issue.rs`、`chat.rs`、`notes.rs`、`plan.rs`、`memory.rs` | 按领域分的工具：工单与帮工、频道、笔记与 Artifact 与媒体、仓库与定时任务、记性 |
| `crates/vibevalley-server/src/modules/team/mcp/resource.rs` | `resource_read`：解析 `vv://` URI，按会话裁剪只读权限、分页 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`orchestrator.*`）。

## 模型和不变量

- **助手是 `role: "orchestrator"` 的档案，固定用 `vibevalley` 农机与 DeepSeek 模型**：默认助手 `orchestrator` 不可删除或改为帮工，名字默认叫「管家」，在它的档案页能改；可建多个助手档案，各自拥有独立的会话与对话文件。
- **路由归属规则**：
  - 频道内未 `@` 他人的发言、频道巡查、未指定执行人的定时任务：归该频道的 `Channel.orchestrator`（未设则归默认助手）。
  - 显式 `@助手` 或 `@<助手档案 id>`、与某助手的私聊、指派给某助手的工单：归对应助手。
- **现状按行发增量**：首次启动或压缩后首轮带完整现状；其余回合只发变化行，超过半数变化时重发全文。
- **输入带来源头，非用户长话截断**：首行标明 `[来源：用户|群聊|工单|定时任务|巡查]`。非用户群聊消息超 800 字时截断并附地址，用户发言从不截断。
- **工具说明以 Rust 为准**：工具的名字、说明和参数 Schema 在 `assets/tools/`，谁能调哪个由它列在哪个文件定。
- **参数解析宽松但只在一处**：数字字符串、`"true"`、`null` 当缺省、多余字段忽略；解析失败时不执行工具，给模型的话统一一处写。
- **`resource_read` 按会话权限只读裁剪并固定分页快照**：投递卡片只带摘要与 `vv://` 指针（Trigger、工单、频道、GitHub 评审线程、Artifact、记忆、仓库）。`resource_read` 不改业务表；助手可读全局资源，帮工仅可读自身工单、父工单、显式 `blockedBy` 工单及所在频道。
- **当轮用户授权检查（`Route.user`）**：仅当本轮批次含用户原话时 `Route.user` 为真；当前在 `cron_create`（后台回合创建的周期/派工任务存为 `pending` 待批）与媒体生成/理解工具中按此门禁拦截，其余四档工单变更硬拦截见下方提案。
- **派活时挑档案**：顺序见[档案和农机](docs/subsystems/agent.md#模型和不变量)。
- **整条消息落库**：完整回复生成后一次性写入频道。
- **忙时来的输入排着，下一轮一起进**：内置引擎与 `WorkerDriver` 原生支持持久 `steer` 插话，但助手为了等同一批次的群聊输入整合后发给同一现状窗口，当前将忙时收到的消息留在信箱队列里，等本轮结束后合并进下一轮（详见 [VibeValley 自己的 agent](docs/subsystems/brain.md)）。

## 工具审批

工具策略要求确认时，执行器保存待批调用并暂停该任务。用户在助手的「执行轨迹」里核对工具名、参数与审批原因，也可以用 `vibevalley approval list --format json` 找到调用。CLI 的 `approval resolve` 接收对话 ID、任务 ID、工具调用 ID 和 `approve` 或 `deny`。工作台和 CLI 使用同一条 Rust 审批契约。

执行器在同一个 SQLite 事务中核对三个 ID、记录决定和唤醒信号，并清除待批项。同一决定可重试。重试上一张审批卡只会读回上一笔决定，即使同一任务已有下一项待批调用。[审批端点](crates/vibevalley-server/src/modules/team/orchestrator/execution.rs) · [决策事务](crates/vibevalley-agent/src/extensions/governance.rs)

## 怎么走

**处理一条输入**

1. 观察层把频道里交给助手的话（或定时任务）交给 `Orchestrator`；它在忙就排着。
2. 拼上来源头、时间与现状（或增量），跑一轮：模型调工具，生成回复。
3. 回复整条写入目标频道。

## 和谁打交道

- **观察层与频道（`watch`、`channel`）**：观察层交来输入；回复经频道 `post` 写回。
- **工单与定时任务**：经工具调 `Board` 和 `Crons`；指派给助手的工单跑完后进 `in_review` 等用户点头。
- **自研 agent 与记性（`vibevalley-agent`、`memory`）**：对话、模型调用与压缩在 `vibevalley-agent`（[VibeValley 自己的 agent](docs/subsystems/brain.md)）；记性工具读写档案的记忆。

## 为什么这样

- **编排策略与对话循环分离**：对话循环、压缩在 `vibevalley-agent`，`modules/team/orchestrator` 只管来源分发、现状拼装与工具绑定。
- **工具对齐协议接口，不起别名**：保证 HTTP、CLI、助手和帮工对同一件事使用完全相同的名字与参数校验。
- **代码硬拦未授权合并，不靠提示词防注入**：在工具里按当轮是否有用户原话拦截工单修改与合并，防止帮工汇报中的提示注入触发合并或花钱。
- **调研记成 `deliver: answer` 工单交给帮工，助手不读代码**：避免读取大量代码撑爆助手常驻对话上下文并破坏前缀缓存。

## 还没做的

- 授权分档、跨轮同意与持续推进交付：[让获授权的工作持续推进并可信交付](.agents/notes/proposed/architecture/2026-11-07-authorized-work-and-prompt-design.md)。
- 按档案配 `toolsets`、助手加载技能与 `/` 调用：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。
- 仓库健康度、早报、工单关系与分拣建议：[助手给用户报告](.agents/notes/proposed/feature/2026-10-21-the-orchestrator-reports.md)。

## 怎么验证

- `crates/vibevalley-server/tests/orchestrator.rs`：用脚本模型让助手听见用户的话、调工具建工单。
- `crates/vibevalley-server/tests/mcp.rs`：帮工经 `/mcp` 调同一套工具与 `resource_read`。
- `orchestrator.eval.create` 已在服务端实现（落盘至 `<家目录>/evals/<id>.json`）；真模型回放评测集尚未接入。
