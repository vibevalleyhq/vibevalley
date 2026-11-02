# VibeValley 四层模块切分与状态收敛方案：重构模块边界，保持状态极简正交

本文解决的核心矛盾是：**VibeValley 最初的模块切分存在历史缺陷（`Channel` 兼职事件总线、`Orchestrator` 成了凌驾万物的上帝服务、`Session` 被错当成帮工、`TaskGraph` 与 `Issue` 造了两套平行状态机）；我们追求的不应是「为了省事而将就旧模块」，也不应是「在旧模块上疯狂叠加新状态」，而是「合理切分出专业模块，同时让每个模块内部的状态极简、正交、不重复」。**

---

## 一、初始代码的四大模块切分缺陷（为什么不能只靠修补和简单复用？）

剖析当前 `apps/server/src/` 的模块结构（`modules.ts`），可以看到早期演进留下的四个根源性架构问题：

1. **缺陷一：`Channel`（1,949 行）把「人类聊天室」和「系统事件总线/信箱」混为一谈**
   - 因为早期先做了聊天室，后来加派活、加叫醒、加三道刹车、加已读回执，全部塞进了 `channel/chat.ts`。
   - 如果为了「复用现有表」把 GitHub CI 失败、PR 行内代码评审（带 `path:line`、`diff_hunk`、`review_thread_id`）、定时触发、巡查发现全部硬塞成「往聊天室发一条 `channel_message`」，就会把人类沟通的聊天室污染成杂乱的机器日志流，且结构化事件元数据无处安放。
2. **缺陷二：`Orchestrator` 成了颠倒因果的「顶层上帝模块」，且与 `Session` 割裂**
   - **概念错位**：管家（`Orchestrator`）和帮工（`Worker`）本质上都是 **Agent（智能体）**，只是角色（`role`）和挂载的工具集不同；在运行时它们**都应基于 `Session`（Agent 会话）管理**。但早期代码把「帮工」硬叫成 `Session`，导致管家无法作为标准 `Session` 管理，只能在 `session/host.ts` 另起一套 `AgentHost` + `InProcessRun` + `OrchestratorState`。
   - **依赖颠倒**：`Orchestrator` 被放在模块第 9 层，import 了 14 个服务。甚至连主人在频道里发一句话，都要先调 `Orchestrator.say` 再由管家去调 `Channel.say`（`apps/server/src/orchestrator/orchestrator.ts:85`），因果关系完全颠倒！
3. **缺陷三：外部接入（Ingress）散落 7 处，没有统一的事件标准化层**
   - 微信/飞书/QQ 归 `connector`，GitHub PR 轮询藏在 `issue/merge.ts` 和 `project/project.ts`，定时归 `cron`，语音归 `voice`，巡查归 `inbox`。7 个地方各自构造不同格式的字符串，绕过统一网关直接去捅 `Orchestrator` 或 `Session`。
4. **缺陷四：`Task`（计划图）与 `Issue`（工单）造了两套平行的状态机与接口**
   - `issue` 表明明已经有 `parent`（父工单）和 `blocked_by`（前置依赖），却在 `apps/server/src/task/` 另造了一套 `GraphState`（7 个状态）、`TaskState`（5 个状态）、7 个 `graph_*` 工具和 `graph-draft / graph-ready / task-failed` 通知，还把子工单变成了 `moves: []` 的假工单。

---

## 二、目标架构：四层专业模块切分 + 镜像 HITL 层（职责锋利、状态正交）

我们按照 **「1. 接入与载荷层 → 2. 网关与双层信箱层 → 3. 契约与工单层 → 4. 拉取原语与信号层（+ 镜像 Human-in-the-Loop 交付层）」** 重新切分服务端模块。

**设计准则**：
- **该拆的模块果断拆开**：让 `Ingress` 专管接入标准化、让 `Mailbox` 专管双层蓄水与分流、让 `Issue` 统管工单与父子 DAG、让 `Session` 统管管家与帮工的会话和信号、让 `Resource` 专管按需分页拉取；
- **状态机严格正交（绝不重复造状态）**：一层只拥有属于自己职责的那 3–5 个核心状态，上层状态由下层事实推导，砍掉一切跨模块复制的状态枚举。

```mermaid
flowchart TB
  subgraph L1["第 1 层：接入与载荷模块 (src/ingress · 服务 Ingress)"]
    AD_GH[GitHub 适配器<br/>PR / CI 指纹 / Review / Inline Thread]
    AD_CN[连接器适配器<br/>微信 / 飞书 / QQ]
    AD_CH[内部交互适配器<br/>Channel 发言 / 看板动作 / 语音 / Cron / Patrol]
    NORM[标准化与载荷卡片化<br/>1. 幂等键去重 & 自发消息过滤 (Self-Echo Drop)<br/>2. 封装统一 Trigger 信封 + 定长 CompactCard + vv:// 资源指针]
    AD_GH & AD_CN & AD_CH --> NORM
  end

  subgraph L2["第 2 层：网关与双层信箱模块 (src/mailbox · 服务 Mailbox)"]
    ROUTER[1. 订阅路由网关 Router & Subscriptions<br/>查 thread_subscription：<br/>• 命中工单订阅 → 锁 followupOwner 进 Tier 1 工单信箱<br/>• 无主事件 / 被帮工 Handback 退回 → 进管家 Session 信箱]
    TIER1[2. Tier 1 工单蓄水池 (issue_mailbox)<br/>承接工单排队期、换人期、以及 waitsForHuman 冻结期<br/>挂起非人工自动信号 (CI / Bot / Cron)]
    TIER2[3. Tier 2 会话信箱与节流泵 (session_mailbox)<br/>统一面向 Session ID（管家 Session + 帮工 Session）<br/>Urgency 四档裁决 + 三道刹车 + 批处理合成]
    ROUTER -->|归属工单| TIER1
    ROUTER -->|归属管家 / 私聊| TIER2
    TIER1 -->|工单有在场 Worker Session 且未冻结| TIER2
  end

  subgraph L3["第 3 层：契约与工单模块 (src/issue · 服务 Issue)"]
    CONTRACT[唯一工作项与契约引擎 Issue<br/>• 唯一状态机：backlog → todo → in_progress → in_review → done | canceled<br/>• 原生父子与 blockedBy DAG（收编原 Task 模块，砍掉 GraphState）<br/>• Mandate 授权边界 + PR Follows 绑定 + Handback 退回契约<br/>• 判定 waitsForHuman（asking / stuck / reviewing 时冻结自动唤醒）]
  end

  subgraph L4["第 4 层：拉取原语与信号模块 (src/session + src/resource)"]
    SIGNAL[统一会话与信号服务 Session<br/>• 统管 Orchestrator Session 与 Worker Session（共用 session / session_run 表）<br/>• 下行信号：Wake(+1 特权槽) / Steer(整批排空) / Preempt(打断未消费回滚)<br/>• 上行信号：Consumed(真实入模) / Settling(后台守候) / HandedOff(留预览释放槽)]
    PULL[统一只读拉取服务 Resource<br/>• resource_read(vv://..., offset, limit)<br/>• 会话级 LRU 快照缓存 TextCache + 契约墙权限隔离]
  end

  subgraph HITL["镜像出站层：Human-in-the-Loop 交付与回执模块 (src/inbox)"]
    HOUT[人类交付门禁与回执 Inbox / Outbox<br/>• 仅放行 HITL 交接项 (asking / reviewing / stuck / ack)，拦截在途 progress<br/>• 结合 channel_read_cursor 判定人类未读 vs 已读：<br/>  - 未读前问题变更 → 自动从 Outbox 撤回旧通知<br/>  - 在场已读 → 抑制微信/飞书重复轰炸，延后 Patrol 催促]
  end

  NORM -->|Trigger 信封| ROUTER
  TIER1 <-->|查询 waitsForHuman 与在场负责人| CONTRACT
  TIER2 -->|下行信号| SIGNAL
  SIGNAL <-->|按需拉取全文/上下文| PULL
  SIGNAL -->|上行信号 Consumed / Report| TIER2 & CONTRACT
  CONTRACT -->|Handback / 关单未读 letGo| ROUTER
  CONTRACT & SIGNAL -->|需人裁决 / 最终验收| HOUT
  HOUT -->|人类已读游标 / 拍板动作| AD_CH
```

---

## 三、四个核心层级的模块边界与精简状态设计

### 第 1 层：接入与载荷模块（`src/ingress`）—— 解决「外部与内部事件怎么标准化进网关」

**为什么要独立切分 `ingress`（或将各源的入站标准化收拢）？**
因为 `Channel` 是内部聊天室，`Project` 是本地 git 操作，它们都不应该背负「外部事件归一化」的职责。

1. **职责边界**：
   - **管什么**：把 8 类事件源（GitHub 轮询、微信/飞书/QQ 连接器、频道/串内人类发言、看板动作、语音通话、定时 `Cron`、巡查 `Patrol`）统一转换为不可变的 **`Trigger`（入站信封）**，并生成定长的 **`CompactCard`（载荷卡片）**。
   - **不管什么**：不管这条事件该分给哪个工单或哪个 Agent（交给第 2 层 `Mailbox`）；不管本地 git 合并（留给 `Project`）；不管聊天室的点赞/置顶（留给 `Channel`）。
2. **核心机制**：
   - **GitHub 增量接入器（`src/ingress` 的 GitHub 子模块）**：轮询绑定 PR 的 `check-runs`/`statuses` 指纹变化、PR Reviews、Inline Review Comments（提取 `path:line` 与 `diff_hunk` 尾部），自动丢弃 Agent 自己的发言（Self-Echo Drop），生成 `source = "github"` 的 `Trigger`。
   - **定长卡片化（Payload Cardification）**：所有 `Trigger` 带 `card: { summary, totalChars, readUri }`（如 `vv://trigger/<id>` 或 `vv://github/<proj>/pulls/<n>/thread/<c>`），从源头保证长日志和大文件绝不直接塞进信箱。
   - **状态数量**：**0 个状态**（`Trigger` 是纯不可变事实记录，按确定性 `id` 幂等去重）。

---

### 第 2 层：网关与双层信箱模块（`src/mailbox`）—— 解决「怎么蓄水、怎么分流、怎么节流」

**为什么要切分成「双层信箱」，又如何做到状态极简？**
因为**「工单/话题（Work Item）」和「Agent 会话（Session）」的生命周期不同步**。当工单还在排队、正在换帮工、或者正卡在 `asking` 等主人拍板时，冲着这张工单来的事件（如 CI 报错、PR 评论、补充说明）必须先在**工单级蓄水**，而不能直接塞给某个 `Session`。

但双层信箱**不需要复杂状态机**，每层只需要 **3 个正交状态**：

#### 2.1 第一层（Tier 1）：订阅路由网关与工单蓄水池
1. **线程订阅表（`mailbox_subscription`）**：
   - 记录工单订阅了哪些 `thread_key`（例如内部工单串 `channel:<thread_id>`、GitHub PR `github:<repo>#<pr>`）。
2. **网关分流决策（纯函数 `routeTrigger`）**：
   - **命中订阅工单**：
     - 若是人类（`owner`）消息：**锁定 `followupOwner` 为该工单**（直接跳过管家，防止管家在旁误建重复新单！），解除该工单的 `waitsForHuman` 冻结阀门，连同池中暂存的信号一起下发给该工单当前的 `Worker Session`（若工单刚关单且非人工取消，则自动唤醒原 `Worker Session` 续接）。
     - 若是自动信号（CI 变化、Bot 评论、定时）：进入该工单的 Tier 1 蓄水池。若工单当前 `waitsForHuman === true`（正等主人回答或排障）或该 PR 的 Review Bot 已满 3 轮，则状态设为 **`held`（挂起蓄水，不下发 Tier 2）**；否则直接下发 Tier 2。
   - **未命中任何工单（或被帮工 `handback` 退回）**：
     - 分流至对应频道管家的 **`Orchestrator Session`** Tier 2 信箱。
3. **Tier 1 状态枚举（仅 3 个）**：
   - `held`（因工单等人类拍板或排队无帮工而蓄水挂起）→ `forwarded`（已下发至 Tier 2 会话信箱）| `returned`（被帮工 `handback` 退回或关单未读 `letGo` 释放回网关交给管家）。

#### 2.2 第二层（Tier 2）：统一面向 `Session` 的执行信箱与节流泵
1. **收件人统一是 `session_id`**：
   - 不再分「管家的 5 条内存流」和「帮工的 `channel_delivery`」——管家的 `Orchestrator Session` 和帮工的 `Worker Session` 都是 `Session`，全部由同一张 `mailbox_delivery` 表和同一个节流泵驱动。
2. **Urgency 四档裁决 + 三道刹车**：
   - 纯函数算 `Urgency`：`interrupt`（叫停）| `steer`（主人对话，Step 边界整批注入）| `queue`（派单/PR 评审/CI 失败/帮工异常汇报，下一轮开跑）| `digest`（普通旁听/完成汇报/巡查，攒批捎带）。
   - 出水口统一过三道刹车（`hopLimit = 4`、`cooldown = 60s`、`wakeBreaker = 3`）。
3. **Tier 2 状态枚举（仅 3 个，砍掉旧的 `announced` 中间态）**：
   - `pending`（待交）→ `handed`（已发信号，等入模确认）→ `consumed`（收到第 4 层 `Signal.Consumed` 确认入模，打 👀）| `dropped`（会话离开或消息撤回）。

---

### 第 3 层：契约与工单模块（`src/issue`）—— 解决「干什么活、边界在哪、父子 DAG 怎么走」

**模块切分核心决策：把原 `src/task`（计划图）收编进 `src/issue`，砍掉整套平行的 `GraphState` / `TaskState`，让 `Issue` 成为唯一的工作项与契约模块。**

1. **唯一的工单状态机（保持现有 6 个状态，零新增状态）**：
   - `backlog`（草稿/待规划）→ `todo`（已派活排队/等前置依赖）→ `in_progress`（帮工 Session 在做）→ `in_review`（等验收）→ `done`（已完成）| `canceled`（已取消）。
2. **原生父子与 `blockedBy` DAG（取代原 `TaskGraph` 状态机）**：
   - 任何 `Issue` 都可以有 `parent`（父工单 ID）和 `blockedBy`（前置工单 ID 列表，复用 `@vibevalley/agent/dag` 做环检测与分层）。
   - **拆解**：规划师或帮工调 `issue_split` 时，直接在父工单下创建一组带 `blockedBy` 的子 `Issue`（它们是拥有完整能力的真工单，不再是 `moves: []` 的假工单！）。
   - **按 DAG 自动调度**：`todo` 状态的工单，当且仅当其 `blockedBy` 列表中的工单全部 `done`（或取消跳过）时，才由调度器派发 `Worker Session`。
   - **父子分支自动汇合**：有 `parent` 的子工单从父工单分支（`vibevalley/issue-<父号>`）开 worktree；子工单做完且通过检查（含冻结测试校验）后，自动用 `git merge-tree` 无检出合入父工单分支并标为 `done`（`delivered: "merged_into_parent"`）；当父工单下所有子工单都 `done` 时，父工单自动进入 `in_review` 请主人点「完成」合入 `main`。
3. **三大工单契约（属性字段，非新状态机）**：
   - **源头与授权契约（`Mandate`）**：记录 `originTriggerId`（帮工可直接拉取主人的一手原话与上下文，管家建单附言硬限 ≤ 30 词，禁止替帮工瞎编方案）、`deliver`（`change | pull_request | branch | answer`）。
   - **在途 PR 跟随契约（`pullRequest`）**：在 PR 项目上，允许帮工在通过本地 `.vibevalley/check` 后直接调 `issue_pr_submit`（或随报告提交）由服务端 `git push` 并创建/更新 PR，将 PR 线程注册进 `Mailbox` 订阅表，立即开启 CI 与 Code Review 自动闭环，不必等主人点「完成」才开 PR。
   - **追问退回契约（`issue_handback` 与关单 `letGo`）**：帮工发现工单串里的追问超出本工单范围时，调 `issue_handback(trigger_id, reason)` 将其退回第 2 层网关转交管家另建新单；工单关单时，自动检查是否有在最后一次汇报之后才到达、未被回應的人类追问（`letGo`），自动释放回管家。

---

### 第 4 层：拉取原语与信号模块（`src/session` + `src/resource`）—— 解决「怎么统一管会话、怎么拉、怎么打断」

#### 4.1 统一 `Session` 服务（正名：管家和帮工都是 Agent，都跑在 `Session` 上）
- **合并宿主**：把原来管家的 `AgentHost` + `InProcessRun` 与帮工的 `Session` 统一为同一个 `Session` 服务。
  - `Session` 按绑定的 `Agent.role` 分为两类实例：**`Orchestrator Session`（常驻进程内 `Brain`）** 与 **`Worker Session`（经 `Executor` 驱动 `oar` 或 `Brain`，绑定工单 worktree 或私聊目录）**。
  - 两者共用同一张 `session` 表、同一张 `session_run` 表、同一套事件日志 `Journal`，以及**同一套阶段状态 `SessionPhase`（`working | resting | done | failed | closed`，砍掉管家专用的 4 个 `OrchestratorState`）**。
- **标准双向信号协议（Signals：Mailbox ⇄ Session）**：
  - **下行信号**：
    1. `Signal.Wake(batch)`：空闲时开启新 `Run`（自动前置拼入 `Memory.recall`）；**若触发源为 `owner` 的评论追问，在 `hiring.ts` 中享有 `+1` 人类唤醒特权槽**，永不被排队的新工单堵死。
    2. `Signal.Steer(batch)`：运行中注入补充卡片；**将 `packages/agent/src/core/loop.ts:307` 的 `takeOne(steering)` 升级为 `takeAll(steering)`**，在当前 Step 工具跑完后一次性排空全部待插话卡片，合成同一次模型请求。
    3. `Signal.Preempt(reason)`：显式叫停信号；被打断时，凡已 `handed` 但尚未收到 `Signal.Consumed` 的投递自动退回 `pending`，下一轮开头绝不丢消息。
  - **上行信号**：
    1. `Signal.Consumed(ids)`：消息真正写入模型请求历史时发出（取代靠 `spoke` 猜的做法），驱动 `Mailbox` 标为 `consumed` 并打 👀。
    2. `Signal.Settling` vs `Signal.HandedOff`：回合结束但仍有子任务/后台命令在跑时守候槽位；交回给主人验收（`HandedOff`）时立即释放干活槽位，但允许保留本地预览 Server 进程供主人验收。

#### 4.2 独立只读拉取服务（`src/resource`：Pull Protocol `resource_read`）
- 从杂乱的业务工具中切出专门的只读上下文拉取层，向管家 Session 和帮工 Session 提供统一的 `resource_read({ uri, offset, limit })`：
  - 支持 `vv://trigger/<id>`（含同串前后 5 条邻居消息 `around`）、`vv://issue/<id>`、`vv://channel/<id>/messages`、`vv://github/<project>/pulls/<n>/checks`、`vv://github/<project>/pulls/<n>/thread/<comment_id>`、`vv://session/<id>/trajectory`。
  - **内置会话级 LRU 快照缓存（`TextCache`）**：`offset = 0` 拉取并冻结快照，`offset > 0` 在内存快照上按 UTF-16 切片翻页，既防翻页错行，又避免重复调 `gh` CLI。
  - **契约墙鉴权**：Worker Session 只能拉取自己工单关联的资源。

---

### 镜像出站层：Human-in-the-Loop 人类交付与回执模块（`src/inbox`）

当第 3 层工单进入需要人类介入的 4 个节点（`backlog` 审草稿、`asking` 答问题、`stuck` 排障、`reviewing` 最终验收）时，由 `Inbox` 模块统一负责**「交付给人（Deliver to Human）」**：

1. **人类交付门禁（Outbox Gate）**：
   - 只有上述 4 类 HITL 节点、管家的直接回话、以及 `@主人` 提及才允许进入 `Inbox` 和外部连接器（`connector_outbox`）；帮工在途的中间动作与等待外部 CI 的过程一律留在内部，不打扰主人。
2. **复用 `channel_read_cursor` 实现未读撤回与已读防打扰（零新增表、零新增状态）**：
   - **未读撤回（`read_cursor < 汇报消息号`）**：主人在工作台没读过该提问、或 `connector_outbox` 还没发出时，若帮工在后续步骤自己解决了问题或更新了问题，直接从 `connector_outbox` 撤回旧通知，不让主人读过期废话。
   - **已读静默（`read_cursor >= 汇报消息号`）**：主人在工作台点开了该工单串（游标已推过），代表主人已 **Seen（在场已读）**——连接器不再往微信/飞书重复发，巡查 `Patrol` 对已读项自动拉长宽限期，不催促正在思考的主人；但若已读后工单状态又发生了意外变化（如刚通过的 CI 突然挂了），则必须发增量提醒。

---

## 四、重构后的模块分层表与状态账本（既切清了模块，又砍掉了冗余状态）

### 4.1 服务端模块单向依赖序（`apps/server/src/modules.ts`）

消除「`Orchestrator` 在最顶层统治一切」和「`Channel` 兼职事件总线」的旧格局，调整为清晰的流水线分层：

| 层序 | 模块名 | 包含目录（`apps/server/src/`） | 核心单一职责 |
|---|---|---|---|
| **1** | **Platform** | `base`, `infra`, `core`, `setting` | 地基、PGlite、配置与核心状态单写者 `Core` |
| **2** | **Agents** | `agent`, `runtime`, `memory` | Agent 档案定义（`orchestrator` \| `worker`）、农机探测与配额、跨档案记忆检索 |
| **3** | **Source Control** | `project` | 纯本地 Git 仓库、worktree、冲突预检（`merge-tree`）、`.vibevalley/check` 与 `gh` 命令封装 |
| **4** | **Collaboration** | `channel`, `artifact` | 纯内部聊天室账本（频道/串/消息/已读游标 `read_cursor`）与协作产出（块/网页） |
| **5** | **Agent Sessions** | `executor`, `session` | **统一的 Agent 会话层**（同时托管管家 Session 与帮工 Session）与第 4 层双向信号（`Wake/Steer/Preempt/Consumed`） |
| **6** | **Issues & Contracts** | `issue`, `cron` | **唯一工作项与契约层**（含原生父子与 `blockedBy` DAG、Mandate、PR Follows、Handback、`waitsForHuman` 判定；收编原 `task`） |
| **7** | **Mailbox & Gateway** | `mailbox` | **双层信箱与路由网关**（Thread 订阅表、Tier 1 工单蓄水池、Tier 2 Session 信箱泵、`Urgency` 4 档 + 三道刹车） |
| **8** | **Ingress & Resource** | `ingress`, `resource`, `orchestrator`, `tool` | **第 1 层入站标准化器**（GitHub/连接器/频道/定时转 `Trigger`）、**第 4 层统一拉取原语 `resource_read`**、管家路由策略与工具表 |
| **9** | **Human Loop (HITL)** | `inbox`, `game` | **人类交付门禁、已读游标联动（撤回/抑制/巡查）** 与游戏化账本 |
| **10** | **Transport Doors** | `http`, `mcp`, `lan`, `connector`, `voice`, `projection` | 对外 HTTP/SSE/RPC/MCP 协议口、连接器长连接收发、声网语音通道与状态帧拼装 |

### 4.2 全局状态精简账本（切清模块的同时，状态不增反降）

| 模块 | 拥有的状态枚举 | 取值（每个模块仅 3–6 个正交值） | 砍掉了什么旧包袱 |
|---|---|---|---|
| **`Ingress`** | 无状态（纯不可变 `Trigger`） | 按幂等 `id` 去重 | 砍掉 7 处散装入口各自拼字符串的野路子 |
| **`Mailbox` (Tier 1)** | `IssueMailState`（3 个） | `held` \| `forwarded` \| `returned` | 取代原 `issue_queue`，并统一承接 `asking/stuck` 期间挂起的 CI/Bot 信号 |
| **`Mailbox` (Tier 2)** | `DeliveryState`（4 个） | `pending` \| `handed` \| `consumed` \| `dropped` | 砍掉旧的 `announced` 态，统一管家与帮工的投递 |
| **`Issue`** | `IssueStatus`（6 个） | `backlog` \| `todo` \| `in_progress` \| `in_review` \| `done` \| `canceled` | **净砍掉原 `TaskGraph` 的 12 个状态（`GraphState` 7 个 + `TaskState` 5 个）和 `Inbox` 的 3 个特例状态** |
| **`Session`** | `SessionPhase`（5 个） | `working` \| `resting` \| `done` \| `failed` \| `closed` | **净砍掉管家专用的 4 个 `OrchestratorState`**，管家与帮工共用 `SessionPhase` |
| **`Inbox` (HITL)** | 不存新状态（由 `read_cursor` 现算） | `cursor < number`（未读）\| `cursor >= number`（已读） | 零新增状态实现未读撤回、跨端防轰炸与巡查防乱催 |

---

## 五、核心状态事实（`Fact`）的命名与结构规整方案

审视 `packages/protocol/src/shapes.ts`（第 2253–2440 行）与 `apps/server/src/projection/reduce.ts` 中的 23 个 `Fact`，可以看到当前 `Fact` 体系存在明显的历史拼凑痕迹：

### 5.1 现有 23 个 `Fact` 的四大命名与结构病灶

1. **残留拟人隐喻导致语义荒谬（`hired` / `left`）**：
   - 会话开启叫 `FactHired`（`type: "hired"`），会话关闭叫 `FactLeft`（`type: "left"`）。
   - 现在管家（`role: "orchestrator"`）也放进了 `state.sessions`（`reduce.ts:47`），结果开机启动内置常驻管家时，发的事实竟然也是 `hired`（「雇佣了管家」），关机时叫 `left`！
2. **`Session` 一家独占了 11 个无主语的碎片 Fact，且 6 个在重复改同一个 `phase` 字段**：
   - `Issue`、`Channel`、`Cron` 都是干净的实体级 Fact（`issue` / `issueGone`、`channel` / `channelGone`、`cron` / `cronGone`）。
   - 唯独 `Session` 散落着 11 个没有 `session` 前缀的裸词：`hired`、`phase`、`station`、`run`、`doing`、`quiet`、`retry`、`spent`、`report`、`conflict`、`left`。
   - 更严重的是：**在 `shapes.ts` 中，`doing`、`quietSince`、`retry` 本来就是 `Session.phase`（`PhaseWorking`）内部的子属性**！但代码里既有一个给管家用的 `FactPhase`（直接传整个 `phase`），又有给帮工用的 `FactRun`、`FactDoing`、`FactQuiet`、`FactRetry`（各自去改 `phase` 的一个子字段），完全是两套写法并存。
3. **属性挂错聚合根（`FactConflict` 挂在 `Session` 而非 `Issue` 上）**：
   - 代码冲突（`conflict`）明明是**工单分支（`Issue`）与主分支**之间的 Git 状态，现在却定义成 `FactConflict { id: SessionId, conflict?: Conflict }` 挂在帮工会话上。一旦帮工收工离开或换人，冲突状态就跟着会话没了。
4. **通用词被游戏皮占用（`FactProgress`、`FactStation`）**：
   - `FactProgress`（`type: "progress"`）实际存的是像素农场的**金币、连胜与成就（游戏进度）**，却霸占了 `progress` 这个最容易被误认为「工单/任务执行进展」的核心词；`FactStation` 则是纯农场皮的站位。

### 5.2 规整原则与收敛对照表（从 23 个收敛为 14 个正交 Fact）

**规整三原则**：
1. **废除拟人隐喻**：`hired` / `left` 统一正名为 `session` / `sessionGone`（或 `session.opened` / `session.closed`），与 `issue` / `issueGone`、`channel` / `channelGone`、`cron` / `cronGone` 保持完全一致的命名队形。
2. **子属性变更收拢进 `sessionPhase`**：`run`（进 `working`）、`doing`（更新当前工具动作）、`quiet`（标静默）、`retry`（标重试）本质上全是在更新 `Session.phase`，统一由 `FactSessionPhase`（`type: "sessionPhase"`）承载，消除管家与帮工的两套更新路径。
3. **物归原主**：`conflict` 归还给 `Issue`；游戏皮肤专用的 `progress`、`commits`、`station` 明确加上 `game` 语义前缀（或收拢为 `FactGame`）。

| 所属模块 | 现有 `Fact`（23 个） | 存在的问题 | 规整后的 `Fact`（14 个） | 规整后的职责说明 |
|---|---|---|---|---|
| **Session**<br>（Agent 会话） | `hired`<br>`left`<br>`phase`<br>`run`<br>`doing`<br>`quiet`<br>`retry`<br>`spent`<br>`report` | • `hired`/`left` 是旧工人隐喻，套在管家会话上语义荒谬；<br>• `phase`/`run`/`doing`/`quiet`/`retry` 5 个 Fact 全在改 `session.phase`；<br>• 缺少 `session` 主语前缀 | **`session`**（原 `hired`）<br>**`sessionGone`**（原 `left`）<br>**`sessionPhase`**（合并 `phase`/`run`/`doing`/`quiet`/`retry` + `spent`）<br>**`sessionReport`**（原 `report`） | • `session`：会话（管家或帮工）创建/入场或基础属性更新；<br>• `sessionGone`：会话结束离场；<br>• `sessionPhase`：会话阶段（含 `working` 下的 `doing`/`quietSince`/`retry`）及实时花费更新；<br>• `sessionReport`：一轮 `Run` 结束并交出结构化报告 |
| **Issue**<br>（工单与契约） | `issue`<br>`issueGone`<br>`conflict`（原挂在 Session 上） | `conflict` 是工单分支与主分支的冲突，挂在 Session 上导致换帮工时丢失 | **`issue`**（含 `conflict` 字段）<br>**`issueGone`** | • `issue`：工单创建或状态/契约/PR/冲突更新；<br>• `issueGone`：工单删除 |
| **Channel & Mailbox**<br>（频道与信箱） | `channel`<br>`channelGone`<br>`message`<br>`ownerMentions` | 命名基本清晰，保持队形 | **`channel`**<br>**`channelGone`**<br>**`message`**<br>**`ownerMentions`** | • `channel` / `channelGone`：频道或串的增改删；<br>• `message`：新消息入账；<br>• `ownerMentions`：未处理的 `@主人` 集合更新 |
| **Cron**<br>（定时任务） | `cron`<br>`cronGone` | 命名清晰，保持不变 | **`cron`**<br>**`cronGone`** | 定时任务的增改与删除 |
| **Gateway**<br>（外联与语音） | `call`<br>`connector` | `call` 偏泛（易与工具调用混淆） | **`voiceCall`**（原 `call`）<br>**`connector`** | • `voiceCall`：语音通话状态变化；<br>• `connector`：外部连接器状态变化 |
| **Game**<br>（农场皮与游戏账本） | `progress`<br>`commits`<br>`station` | `progress` 极易被误认为任务进度；`station` 是农场皮的坐标 | **`gameProgress`**（合并 `progress` + `commits` + `station`） | 统一承载金币、成就、等级（commit 数）与农场画面站位，不再占用顶层业务词汇 |

---

## 六、全仓隐性架构债务盘点与减法清单（表结构、协议、存储、传输）

顺着「模块切分清晰、状态与存储极简正交」的标准继续深挖 `apps/server/db/migrations/0001_schema.up.sql`、`packages/protocol/src/shapes.ts` 与 `apps/server/src/`，还可以一次性清掉以下 **7 项隐性技术债**：

### 债务 1：四套重叠的「执行关联与最近一轮记录」（`issue.last_run` vs `session_run` vs `issue_assignment_execution`）

- **代码现场**：
  - `0001_schema.up.sql:167` 在 `issue` 表上存了一个 JSON 列 `last_run`（对应 `T.Issue.lastRun?: IssueRun`），专门记「管家（进程内 Agent）在这张工单上的最近一轮」；
  - `0001_schema.up.sql:180` 的 `issue_assignment_execution` 表专门建了一个枚举 `executor_kind ('session' | 'orchestrator')`；
  - 同时系统里已经有 `session_run` 表（第 269 行）、`session_run_issue` 表（第 412 行）和 `T.Session.lastRun`（`shapes.ts:517`）。
- **根因**：全是因为以前「管家不进 `session` 表」，导致派给管家的工单找不到关联的 `Session`，只能在 `issue` 表和关联表上打补丁。
- **减法方案**：
  1. 管家会话（`Orchestrator Session`）统一进 `session` 表后，**直接删除 `issue.last_run` 列和 `T.IssueRun` 类型**；
  2. **删除 `issue_assignment_execution_executor_kind` 枚举**，`issue_assignment_execution.executor` 统一外键指向 `session(id)`。

### 债务 2：三张表重复记录「谁看过了哪条消息」（`channel_read_cursor` vs `channel_seen_mark` vs `mailbox_delivery`）

- **代码现场**（`0001_schema.up.sql:108-119, 227-247`）：
  - `channel_read_cursor (participant_id, channel_id, read_number)` 记每个参与者在每个频道/串读到了第几条 `number`；
  - `channel_seen_mark (participant_id, message_id)` 又单独建表记某个参与者看没看过某条 `message_id`；
  - `mailbox_delivery` 第三处记某个 `session_id` 对某条消息的 `state = 'seen'` 与 `seen_at`。
- **根因**：早期频道模块的「新鲜度拦截（发话前先看未读）」自己建了 `channel_seen_mark`，后来加信箱投递和已读游标时没有合并。
- **减法方案**：
  - 频道与串内的消息拥有严格递增的 `number`（1, 2, 3…）。人类的已读进度和帮工主动调用 `channel_message_list` 的阅读进度统一只看 **`channel_read_cursor.read_number`**；帮工被动收到的投递回执统一只看 **`mailbox_delivery.seen_at`**。
  - **直接删除 `channel_seen_mark` 表**，消除三处写已读的事务负担。

### 债务 3：排队与路由碎片表（`issue_queue` 与 `mailbox_route`）

- **代码现场**（`0001_schema.up.sql:254-267, 418-422`）：
  - 既有 `issue_queue (issue, channel, triggered_by)` 记工单排队上下文，又有 `mailbox_issue (trigger_id, issue_id, state, ...)` 记工单蓄水池，还有一张只有两列的 `mailbox_route (envelope_id, routed_at)`。
- **减法方案**：
  1. **删除 `issue_queue` 表**：工单在 `todo` 排队等空位时，触发它的原始 `Trigger` 本来就躺在 `mailbox_issue`（状态 `held`）里，空位释放时直接从 `mailbox_issue` 取出来派发 `Session`，不需要两张排队表；
  2. **删除 `mailbox_route` 表**：一个 `Trigger` 是否已完成路由，直接作为 `ingress_trigger` 表上的状态/时间戳列（`routed_at`），省去跨表 join。

### 债务 4：数据库中重复定义 4 次的 Actor 枚举（`ActorKind` 碎片化）

- **代码现场**（`0001_schema.up.sql:6, 282, 293, 319`）：
  - `task_event_actor`、`cron_set_by`、`memory_author` 三个 Postgres `ENUM` 的取值完全相同（`'owner', 'orchestrator', 'session', 'system'`），外加 `channel_participant_kind` 和协议层的 `TriggerActorKind`。
- **减法方案**：
  - 在 `0001_schema.up.sql` 顶部只定义一个全局共用的 **`actor_kind` 枚举**；
  - 随着 `TaskGraph` 并入 `Issue`，**直接删除 `task_event` 表及其两个枚举（`task_event_kind`、`task_event_actor`）**，工单与子工单的里程碑统一由 `issue/timeline.ts` 的 `milestonesOf` 生成。

### 债务 5：存储双源分裂（PGlite 数据库 vs 家目录散落的 `state.json`、`spend.json`、`MEMORY.md`）

- **代码现场**（`docs/architecture.md:96-111`）：
  1. **`state.json` 与 `session` 表双源对账**：`session` 表（`0001_schema.up.sql:202`）其实已经持久化了 `place`、`oar_session`、`last_text`、`recalled`、`pending_report`；但核心状态里的 `sessions` 和 `commits` 却还在防抖写 `state.json`，开机时两边对账，对不上就报 `lost`。
  2. **`spend.json` 与 `session_run.spent` 双源记账**：每轮花费已经记在 `session_run` 表和 `Runtime` 统计里，却另存一份 `spend.json`。
  3. **管家 `MEMORY.md` 与帮工 `memory` 表双源分流**：`apps/server/src/memory/memory.ts` 被迫对管家读写磁盘文本文件 `MEMORY.md`（按行算 hash），对帮工读写 PGlite 的 `memory` 表（而 `memory` 表第 317 行早就预留好了 `scope` 等字段）。
- **减法方案**：
  - **PGlite（`db/`）作为运行时可变状态的唯一真相源（Single Source of Truth）**：
    - 开机直接从 `session` 表恢复在场 `Session`，**彻底删除 `state.json` 和开机双源对账逻辑**；
    - 管家的记性统一迁入 PGlite 的 `memory` 表（可通过 `artifact.markdown.get` 导出 Markdown），消除 `memory.ts` 里的双轨分支。

### 债务 6：核心业务形状 `Session` 中混入了纯像素农场动画数据（`SessionPlay`）

- **代码现场**（`packages/protocol/src/shapes.ts:493-524`、`apps/server/src/projection/reduce.ts:48, 59, 63`）：
  - 核心状态里的业务实体 `T.Session` 上挂着 `play?: SessionPlay`（内含农场站位 `station`、最近工具动画历史 `history: PlayAction[]`、碰过的文件和命令计数），每次 `FactRun`、`FactDoing`、`FactStation` 都在 `reduce` 里修改 `Session`。
- **减法方案**：
  - 严格遵守「先有概念，再有皮」：`T.Session` 只保留纯粹的会话业务字段；小动物在农场里的站位和动画历史移入 `FarmView`（`StateFrame.view`），由 `game` 模块订阅事件维护，让业务层 `Session` 与像素农场皮彻底解耦。

### 债务 7：客户端与服务端之间同时维护 4 条长连接通道

- **代码现场**（`docs/architecture.md:78-90`）：
  - 目前同时存在 `GET /api/v1/state`（SSE 状态帧）、`GET /api/v1/live`（SSE 窄流：轨迹 step、提醒 notice、农机 runtime）、`GET /api/v1/events`（SSE 调试全流）和 `/api/v1/rpc`（Effect RPC WebSocket 频道消息流）。
- **减法方案**：
  - 按提案 [页面的连接接着带上在线状态和工单的增量](.agents/notes/proposed/architecture/2026-10-27-presence-and-entity-deltas.md) 的方向，将 `state`、`live` 与频道订阅收敛到同一条多路复用连接上，消除多条 SSE + WebSocket 并存的连接管理与重连复杂度。

---

## 七、总体收益汇总：做完这套切分与减法后，系统会变成什么样？

| 维度 | 清理前（现状） | 清理并切分后（目标态） |
|---|---|---|
| **核心业务模块切分** | `Channel`（1,949 行）兼职事件总线，`Orchestrator` 在顶层 import 14 个模块，7 处入口各走各路 | **四层流水线 + 镜像 HITL**：`Ingress`（接入标准化）→ `Mailbox`（双层信箱与路由）→ `Issue`（唯一工单与原生 DAG 契约）→ `Session & Resource`（统一会话、双向信号与 `resource_read` 拉取）+ `Inbox`（人类已读联动门禁） |
| **协议 `Fact` 数量** | **23 个**（含 `hired`/`left` 拟人词、`Session` 11 个无前缀碎片、挂错地方的 `conflict`） | **14 个**（全部按 `<模块/实体>` 规整命名，`Session` 仅留 `session` / `sessionGone` / `sessionPhase` / `sessionReport` 4 个） |
| **状态枚举总数** | 多套平行状态机叠加（`GraphState` 7 + `TaskState` 5 + `OrchestratorState` 4 + `InboxKind` 11…） | **净删 19+ 个状态枚举值**（砍掉独立 `TaskGraph` 状态机与管家特例状态，所有模块状态不超过 3–6 个正交值） |
| **冗余数据库表与列** | `issue.last_run`、`channel_seen_mark`、`issue_queue`、`mailbox_route`、`task_event`、4 套重复 Actor 枚举 | **净删 4 张冗余表 + 1 个冗余 JSON 列 + 5 个重复 Postgres ENUM**，并淘汰 `state.json` 双源对账 |
| **Agent 端到端能力** | 帮工被动等主人点按钮，PR 开出后对 CI 失败与 Code Review 完全失明，串跑题无法退回 | **全闭环自治 + 精准 HITL**：支持在途提 PR、自动盯 CI 与回复 Inline Review、3 轮 Bot 刹车、超范围追问 `handback` 退回、未读前提问自动撤回、在场已读防轰炸 |
