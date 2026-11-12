# 助手

助手（`Orchestrator`）是直接与用户对话的编排 agent：接收需求、创建与指派工单、跟进进度、转告结果。助手不读代码、不跑命令、不改代码，运行在进程内 [VibeValley 自己的 agent](docs/subsystems/brain.md) 上（使用 `role: "orchestrator"` 档案，默认为 `orchestrator`）。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 助手输入拼装：来源标记、时间、现状增量（`situationDelta`）、记忆增量与汇报摘要 | 谁该被唤醒、刹车与投递队列（[帮工的信箱](docs/subsystems/session.md#触发与投递)） |
| 助手与帮工的工具表声明（`apps/server/src/gateway/tool/`，网关的一部分，助手经自己声明的 `OrchestratorTools` 在组装时拿到）及用户授权门禁（`actsForUser`） | 工具背后的业务执行（[工单](docs/subsystems/issue.md)、[频道](docs/subsystems/channel.md)、[定时任务](docs/subsystems/cron.md)） |
| 按档案管理多个助手实例、将回复写回频道或语音响应端口 | 对话循环、前缀缓存、上下文压缩与断点续跑（[VibeValley 自己的 agent](docs/subsystems/brain.md)、[帮工](docs/subsystems/session.md)） |
| 错轮评测录制（`orchestrator.eval.create`） | 挑档案算法 `Runtime.choose` 与农机可用性检查（[档案和农机](docs/subsystems/agent.md#模型和不变量)）、语音通话传输（[语音](docs/subsystems/voice.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/modules/orchestrator/orchestrator.ts` | 管理各助手 `AgentHost` 实例、消费 `Session.deliveries` 的 `Handed`、拼装输入并写回回复 |
| `apps/server/src/modules/orchestrator/situation.ts` | 农场现状增量 `situationDelta` 与长汇报截断 |
| `apps/server/src/modules/orchestrator/response.ts`、`openai.ts` | 电话与 `POST /v1/chat/completions` 的进程内流式响应端口（`Caller`） |
| `apps/server/src/modules/orchestrator/prompts.ts` | 助手系统提示词；现状和工具共用的频道一行（`channelLine`）、笔记命中一行（`pkmHitLine`） |
| `apps/server/src/gateway/tool/tool.ts`、`schemas.ts`、`prompts.ts` | 助手和帮工 `/mcp` 的工具；参数与接口权限对应，媒体流程由脚本模型验证 |
| `apps/server/src/gateway/tool/resource.ts` | `resource_read`（`Tool.readResource`）：解析 `vv://` URI，执行会话级只读权限裁剪与 UTF-16 快照分页（`TextCache`） |
| `$VIBEVALLEY_HOME/agent/<档案 id>/` | 错轮评测 `evals/`；对话在 `$VIBEVALLEY_HOME/durable.db` |
| `apps/web/src/features/orchestrator/OrchestratorPage.tsx` | 工作台助手页（记性、轨迹、声音） |

接口见 [capabilities.md](docs/reference/capabilities.md)（`orchestrator.*`）。

## 模型和不变量

- **助手是 `role: "orchestrator"` 的档案，固定用 `vibevalley` 农机与 DeepSeek 模型**：默认助手 `orchestrator` 不可删除或改为帮工，名字默认叫「管家」，在它的档案页能改；可建多个助手档案，各自拥有独立的 `Session`、`AgentHost` 与对话文件。
- **路由归属规则**：
  - 频道内未 `@` 他人的发言、频道巡查、未指定执行人的定时任务：归该频道的 `Channel.orchestrator`（未设则归默认助手）。
  - 显式 `@助手` 或 `@<助手档案 id>`、与某助手的私聊、指派给某助手的工单：归对应助手。
  - 电话、听写与 `/v1/chat/completions`：归默认助手。
- **现状按行发增量（`situationDelta`）**：首次启动、压缩后首轮或忙时入队带完整现状；其余回合只发变化行，超过半数变化时自动重发全文。
- **输入带来源头，非用户长话截断**：首行标明 `[来源：用户|群聊|工单|定时任务|巡查]`。非用户群聊消息超 800 字时截断并附地址，用户发言从不截断。
- **工具名与参数对齐协议接口**：工具名由接口 `op` 将 `.` 换为 `_` 得出，参数复用接口 Schema（模型专用字段放 `agentOnly`），由 `tool/tool.test.ts` 校验。
- **工具枚举在入口归一，非法值拒绝**：状态和优先级接受标准值与别名；未传才是缺省，非法值不转成缺省。解码失败时不执行工具的业务函数，`tool/schemas.test.ts` 验证这条。
- **`resource_read` 按会话权限只读裁剪并固定分页快照**：投递卡片只带摘要与 `vv://` 指针（Trigger、工单、频道、GitHub 评审线程、Artifact、记忆、仓库）。`Tool.readResource` 不改业务表、不推进消费回执；助手可读全局资源，帮工仅可读自身工单、父工单、显式 `blockedBy` 工单及所在频道，首次读取（`offset = 0`）写入会话级 LRU `TextCache` 以保证后续分页一致。
- **改工单与定周期任务须有当轮用户授权（`actsForUser`）**：仅当本轮最新输入含用户原话时 `Actor.forUser` 为真；否则调 `issue_update`、`issue_status_update` 直接拒绝，调周期/派工 `cron_create` 存为 `pending` 待批。
- **派活时挑档案**：调 `Runtime.choose`，顺序见[档案和农机](docs/subsystems/agent.md#模型和不变量)。
- **整条消息落库，流式字只走响应端口**：思考与书写阶段更新助手 `Session.phase`（`thinking` / `speaking_text`）与 `channel`；完整回复生成后一次性写入频道，若带 `responsePort` 则同步流式推送。

## 怎么走

**处理一条输入**

1. `Session.deliveries` 的 `Handed` 交来待处理的信，并附上期间已完成汇报与巡查摘要（`Session.digest`）。
2. 按 `intake` 表投递：纯用户发言、电话和 `chat/completions` 调 `send` 插话；含帮工发言的群聊、工单、定时和巡查调 `later` 排队。
3. 模型调工具并生成回复，整条写入目标频道，在轨迹中记录 `llm/usage`（含缓存命中率）。

**重启续跑与错轮评测**

1. 启动时先给每个助手造好宿主，再让对话里没跑完的一轮接着跑（30 分钟以前开始的那轮停下、记一条）（[VibeValley 自己的 agent](docs/subsystems/brain.md#接着做被打断的一轮)）。
2. 用户在轨迹页点「这一轮做错了」（`orchestrator.eval.create`），服务端提取该轮上下文、输入、记忆快照与输出存为 `evals/<id>.json`，供加入 `testdata/evals/` 回归测试。

## 和谁打交道

- **帮工与频道（`session`、`channel`）**：经 `Session.host` 在农场的 `Harness` 上运行助手的对话，从 `Session` 收投递（`deliveries`）与摘要（`digest`）、退回用 `handBack`；经 `Channel.post` 的 `Run` 写回回复。
- **工单与定时任务（`issue`、`cron`）**：通过 `tool` 调用服务方法；指派给助手的工单跑完后进 `in_review` 等用户点头。
- **自有 agent 工具与记性（`packages/agent`、`memory`）**：挂载助手扩展并经 `MemoryPort` 读写 `memory` 表。
- **语音（`voice`）**：经 `response.ts` 的 `Caller` 端口向电话流式推送回答文本。

## 为什么这样

- **编排策略与运行机器分离**：起大脑、排队列、记 `Run` 和断点续跑收在 `session/host.ts` 的 `AgentHost`，`orchestrator/` 只管来源分发、现状拼装与工具绑定。
- **工具对齐协议接口，不起别名**：保证 HTTP、CLI、助手和帮工对同一件事使用完全相同的名字与参数校验。
- **代码硬拦未授权合并，不靠提示词防注入**：在服务层按 `Actor.forUser` 拦截工单修改与合并，防止帮工汇报中的提示注入触发合并或花钱。
- **调研记成 `deliver: answer` 工单交给帮工，助手不读代码**：避免读取大量代码撑爆助手常驻对话上下文并破坏前缀缓存。

## 还没做的

- 授权分档、跨轮同意与持续推进交付：[让获授权的工作持续推进并可信交付](.agents/notes/proposed/architecture/2026-11-07-authorized-work-and-prompt-design.md)。
- 按档案配 `toolsets`、助手加载技能与 `/` 调用：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。
- 仓库健康度、早报、工单关系与分拣建议：[助手给用户报告](.agents/notes/proposed/feature/2026-10-21-the-orchestrator-reports.md)。

## 怎么验证

- `apps/server/src/modules/orchestrator/orchestrator.test.ts`、`situation.test.ts`、`apps/server/src/modules/session/host.test.ts`：多助手路由、现状增量、长文截断與 `forUser` 授权测试。
- `apps/server/src/gateway/tool/tool.test.ts`、`resource.test.ts`、`textCache.test.ts`：工具名、权限与参数 Schema 一致性，`vv://` 跨工单越权拦截与 LRU 快照分页测试。
- `apps/server/src/modules/orchestrator/evals.test.ts`、`evals.live.test.ts`：评测断言与真模型回放测试。
