# 管家

管家（`Orchestrator`）是直接与主人对话的编排 agent：接收需求、创建与指派工单、跟进进度、转告结果。管家不读代码、不跑命令、不改代码，运行在进程内 [VibeValley 自己的 agent](docs/subsystems/brain.md) 上（使用 `role: "orchestrator"` 档案，默认为 `orchestrator`）。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 管家输入拼装：来源标记、时间、现状增量（`situationDelta`）、记忆增量与汇报摘要 | 谁该被唤醒、刹车与投递队列（[Mailbox](docs/subsystems/mailbox.md)） |
| 管家与帮工的工具表声明（`apps/server/src/tool/`）及主人授权门禁（`actsForOwner`） | 工具背后的业务执行（[工单](docs/subsystems/issue.md)、[频道](docs/subsystems/channel.md)、[定时任务](docs/subsystems/cron.md)） |
| 按档案管理多个管家实例、将回复写回频道或语音响应端口 | 对话循环、前缀缓存、上下文压缩与断点续跑（[VibeValley 自己的 agent](docs/subsystems/brain.md)、[帮工](docs/subsystems/session.md)） |
| 挑档案算法（`Runtime.choose`）与错轮评测录制（`orchestrator.eval.create`） | 农机可用性检查（[档案和农机](docs/subsystems/agent.md)）与语音通话传输（[语音](docs/subsystems/voice.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/orchestrator/orchestrator.ts` | 管理各管家 `AgentHost` 实例、消费 `Mailbox.forOrchestrator`、拼装输入并写回回复 |
| `apps/server/src/orchestrator/situation.ts` | 农场现状增量 `situationDelta` 与长汇报截断 |
| `apps/server/src/orchestrator/response.ts`、`openai.ts` | 电话与 `POST /v1/chat/completions` 的进程内流式响应端口（`Caller`） |
| `apps/server/src/orchestrator/prompts.ts` | 管家系统提示词 |
| `apps/server/src/tool/tool.ts`、`schemas.ts`、`prompts.ts` | 管家和帮工 `/mcp` 的工具；参数与接口权限对应，媒体流程由脚本模型验证 |
| `$VIBEVALLEY_HOME/agent/<档案 id>/` | 对话文件 `<档案 id>.jsonl`、压缩归档 `archive/` 与错轮评测 `evals/` |
| `apps/web/src/features/orchestrator/OrchestratorPage.tsx` | 工作台管家页（记性、轨迹、旧账、声音） |

接口见 [capabilities.md](docs/reference/capabilities.md)（`orchestrator.*`）。

## 模型和不变量

- **管家是 `role: "orchestrator"` 的档案，固定用 `vibevalley` 农机与 DeepSeek 模型**：默认管家 `orchestrator` 不可删除或改为帮工；可建多个管家档案，各自拥有独立的 `Session`、`AgentHost` 与对话文件。
- **路由归属规则**：
  - 频道内未 `@` 他人的发言、频道巡查、未指定执行人的定时任务：归该频道的 `Channel.orchestrator`（未设则归默认管家）。
  - 显式 `@管家` 或 `@<管家档案 id>`、与某管家的私聊、指派给某管家的工单：归对应管家。
  - 电话、听写与 `/v1/chat/completions`：归默认管家。
- **现状按行发增量（`situationDelta`）**：首次启动、压缩后首轮或忙时入队带完整现状；其余回合只发变化行，超过半数变化时自动重发全文。
- **输入带来源头，非主人长话截断**：首行标明 `[来源：主人|群聊|工单|定时任务|巡查]`。非主人群聊消息超 800 字时截断并附地址，主人发言从不截断。
- **工具名与参数对齐协议接口**：工具名由接口 `op` 将 `.` 换为 `_` 得出，参数复用接口 Schema（模型专用字段放 `agentOnly`），由 `tool/tool.test.ts` 校验。
- **工具枚举在入口归一，非法值拒绝**：状态和优先级接受标准值与别名；未传才是缺省，非法值不转成缺省。解码失败时不执行工具的业务函数，`tool/schemas.test.ts` 验证这条。
- **改工单与定周期任务须有当轮主人授权（`actsForOwner`）**：仅当本轮最新输入含主人原话时 `Actor.forOwner` 为真；否则调 `issue_update`、`issue_status_update` 直接拒绝，调周期/派工 `cron_create` 存为 `pending` 待批。
- **挑档案顺序（`chooseAgent`）**：依次匹配：点名的档案名/ID → 指定农机首个可用档案 → 主人界面选定档案 → 工单文字命中 `Agent.tags` 最多的可用档案。
- **整条消息落库，流式字只走响应端口**：思考与书写阶段更新管家 `Session.phase`（`thinking` / `speaking_text`）与 `channel`；完整回复生成后一次性写入频道，若带 `responsePort` 则同步流式推送。

## 怎么走

**处理一条输入**

1. `Mailbox.forOrchestrator` 投递待处理信封，并附上期间已完成汇报与巡查摘要（`orchestratorDigest`）。
2. 按 `intake` 表投递：纯主人发言、电话和 `chat/completions` 调 `send` 插话；含帮工发言的群聊、工单、定时和巡查调 `later` 排队。
3. 模型调工具并生成回复，整条写入目标频道，在轨迹中记录 `llm/usage`（含缓存命中率）。

**重启续跑与错轮评测**

1. 启动时检查各管家 `.jsonl` 末尾：若停在 30 分钟内未完结的工具调用或输入，自动补入重启说明并跑完该轮（[VibeValley 自己的 agent](docs/subsystems/brain.md#接着做被打断的一轮)）。
2. 主人在轨迹页点「这一轮做错了」（`orchestrator.eval.create`），服务端提取该轮上下文、输入、记忆快照与输出存为 `evals/<id>.json`，供加入 `testdata/evals/` 回归测试。

## 和谁打交道

- **信箱与频道（`mailbox`、`channel`）**：从 `Mailbox` 收投递与摘要，经 `Channel.orchestratorSays` 写回回复。
- **工单与定时任务（`issue`、`cron`）**：通过 `tool` 调用服务方法；指派给管家的工单跑完后进 `in_review` 等主人点头。
- **帮工与大脑（`session`、`packages/agent`）**：经 `Session.host` 运行 `Brain`，经 `MemoryPort` 读写 `memory` 表。
- **语音（`voice`）**：经 `response.ts` 的 `Caller` 端口向电话流式推送回答文本。

## 为什么这样

- **编排策略与运行机器分离**：起大脑、排队列、记 `Run` 和断点续跑收在 `session/host.ts` 的 `AgentHost`，`orchestrator/` 只管来源分发、现状拼装与工具绑定。
- **工具对齐协议接口，不起别名**：保证 HTTP、CLI、管家和帮工对同一件事使用完全相同的名字与参数校验。
- **代码硬拦未授权合并，不靠提示词防注入**：在服务层按 `Actor.forOwner` 拦截工单修改与合并，防止帮工汇报中的提示注入触发合并或花钱。
- **调研记成 `deliver: answer` 工单交给帮工，管家不读代码**：避免读取大量代码撑爆管家常驻对话上下文并破坏前缀缓存。

## 还没做的

- 授权、责任、恢复与交付共同约束提示词：[让获授权的工作持续推进并可信交付](.agents/notes/proposed/architecture/2026-11-07-authorized-work-and-prompt-design.md)。
- 按档案配 `toolsets`、管家加载技能与 `/` 调用：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。
- 按动作分档授权与跨轮同意：[管家的授权](.agents/notes/proposed/feature/2026-10-21-orchestrator-authorization.md)。
- 仓库健康度、早报、工单关系与分拣建议：[管家给主人报告](.agents/notes/proposed/feature/2026-10-21-the-orchestrator-reports.md)。

## 怎么验证

- `apps/server/src/orchestrator/orchestrator.test.ts`、`situation.test.ts`、`apps/server/src/session/host.test.ts`：多管家路由、现状增量、长文截断與 `forOwner` 授权测试。
- `apps/server/src/tool/tool.test.ts`：工具名、权限与参数 Schema 一致性测试。
- `apps/server/src/orchestrator/evals.test.ts`、`evals.live.test.ts`：评测断言与真模型回放测试。
