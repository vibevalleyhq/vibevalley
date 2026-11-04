# Agent Note: 契约按概念竖着分，输入的记录归信箱，大模块拆成内部的几块

Status: implemented

## Problem

服务端和页面按概念竖着分（一个概念一个模块、一个 feature），有三处还是横着的，每个功能都要穿过它们：

- **契约**：`packages/protocol/src/shapes.ts`（3017 行、509 个声明，约二十个概念交错排着）、`schema.ts`（2491 行）、`api.ts`（1490 行，`Handlers` 接口和 `endpoints` 表），加上服务端根目录的 `handlers.ts`。10 月以来 442 个提交里，`shapes.ts` 改了 51 次、`schema.ts` 48 次、`handlers.ts` 36 次、`api.ts` 29 次；加一个笔记模块要在这四个文件的末尾各追加一段。
- **一条输入送到 agent 的记录**：`ingress_trigger` 表名归 `ingress`（Ingress 层，排第 8），可写它的是 `mailbox/payload.ts` 的 `recordTrigger` 和 `mailbox` 的路由回执（Mailbox 层，排第 5）；`ingress` 文件夹本身是顶层的入口（主人说话、GitHub 事件），依赖频道、工单、产出。
- **一个模块一个服务，在大模块里成了一个闭包**：`Issue`（26 个方法，`issue.ts` 1438 行）、`Channel`（50 个方法，`channel.ts` 1511 行）、`Session`（36 个方法，`session.ts` 1420 行）是全仓库改得最多的三个文件。

## Decision

### 1. 契约按概念分

`packages/protocol/src/<概念>/` 一个概念一个文件夹，名字和服务端的模块一样：`shapes.ts`（形状）、`schema.ts`（每个形状的 Schema）、`api.ts`（这个概念的 `XHandlers` 和接口表的那一段 `xEndpoints`）。概念：`common`、`core`、`agent`、`runtime`、`memory`、`project`、`session`、`mailbox`、`channel`、`artifact`、`pkm`、`issue`、`cron`、`inbox`、`orchestrator`、`game`、`lan`、`connector`、`voice`、`setting`。

- `src/shapes.ts`、`src/schema.ts` 只有 `export *`；`src/api.ts` 用 `interface Handlers<R> extends …` 和 `endpoints = [...coreEndpoints, …]` 把各段拼起来，留着 `kebab`、`commandOf`、`readsOnly`、`fieldsOf`。外面的 import（`@vibevalley/protocol`、`/schema`、`/api`）一个都没改。
- 接口共用的（`Caller`、拒绝和 `ApiError` 的 Schema、`errorStatus`、`Endpoint`、`input`）在 `src/endpoint.ts`；`Wire` 和 `Codec` 在 `src/codec.ts`。
- 各概念的 Schema 互相引用时直接 import 那个概念的 `schema.ts`。切分时算出的环用挪归属拆开，不合并文件夹：带品牌的 id（`IssueId`、`SessionId`……）和 `KeySource`、`KeyStatus` 归 `common`，`IssueTemplate` 归 `project`，`MCPServer` 归 `agent`，`IssueAnswer` 归 `session`。
- 接口表按概念的顺序拼起来；命令行的帮助、能力表的顺序跟着变，`vp run capabilities`、`vp run api:client`、命令行的黄金数据重写过。`schema.test.ts` 读每个 `<概念>/shapes.ts`。

### 2. 处理函数按概念分

根目录的 `handlers.ts` 只合并 `http/handlers/<概念>.ts`，每个文件是 `Handlers` 的一段（类型是那个概念的 `XHandlers`）。处理函数留在 Gateway：一个接口常要用到几个模块（`artifact.list` 要 `issues.idOf`），放进各模块的文件夹会倒着 import。帮工和管家的工具（`tool/`）留在 Orchestrator。

### 3. 触发的记录归信箱

`ingress_trigger` 改名 `mailbox_trigger`，查询在 `db/queries/mailbox_trigger.sql`；`ingress` 只留入口（`ingress.ts`、`github.ts`），经 `mailbox/payload.ts` 的 `keepSourceTrigger`、`keptTrigger`、`knownGitHubEvents` 读写它，表 `ingress_github` 仍归它。`modules.test.ts` 有一张 `foreignReads` 名单：一个模块只调自己表的查询，名单上点名的读投影除外（信箱读频道和工单的几个，Inbox 读 `channel_message` 的三个），命名空间 import 和别人表的写都不放过。

### 4. 大模块拆成内部的几块

对外仍然一个模块一个服务，`make` 里依次造出几块，每块是同一个文件夹里的一个工厂（`Effect.gen`，自己 `yield*` 它用到的服务），只拿排在它前面的几块给它的，返回别的块和对外的服务要用的：

- `Issue`：`records.ts`（`issueRecords`：工单的行、内存里的派工 `Assignments`、发布到核心状态）→ `split.ts`（`issueSplitting`：拆子工单、子工单合进父工单）→ `dispatch.ts`（`issueDispatch`：雇帮工、交给管家、排队、重开、定时任务的一轮）→ `settle.ts`（`issueSettling`：挪状态前定下的和试挪的说法）；`issue.ts` 拼起 `Issue`，留着挪状态、带话、取消、验收、帮工历史。
- `Channel`：`records.ts`（`channelRecords`：模型和数据库、那把锁、名字和目标、帧、串、已读游标）→ `writing.ts`（`channelWriting`：写一条消息）→ `threads.ts`（`sessionThreads`：会话的串和开机恢复）→ `talk.ts`（`directTalk`：私聊起会话）。默认频道不再另存一个 `let`，由模型答（`ChatModel.defaultId()`，它本来就记着 `is_default`）。
- `Session`：`records.ts`（`sessionRecords`：hand 和它们的行、run 的记账、流、令牌、退出时的保存）→ `watch.ts`（`sessionWatch`：跟着一次 launch）→ `launch.ts`（`sessionLaunch`：开、唤醒、歇下、交出现场）。`/mcp` 的地址是 `records.ts` 里的 `mcpEndpoint`（`setAddress` 改它），`hired` 留在 `session.ts` 和 `restore` 一起。

锁、内存里的索引和可变的值只在一块里：别的块经它的方法拿，不复制；块之间不 import 拼它们的文件（`import/no-cycle`），所以几块共用的类型（`Hand`、`RunStore`、`NotTakenIn`）放在定义它的块里，`session.ts` 再导出。

## Alternatives considered

- **契约里的形状和 Schema 放进一个文件。** `shapes.ts` 只有类型和常量，`schema.ts` 是运行时的值；放一起会让只要类型的页面也拉进全部 Schema。分在同一个文件夹里已经挨着。
- **Schema 成环的概念放进同一个文件夹。** 环是几个共用的形状放错了地方（id、钥匙的来源），挪归属以后概念之间没有环，不用合并。
- **处理函数、工具放进各模块的文件夹。** 一个接口要用几个模块的服务，放在拥有概念的模块里就要 import 排在后面的模块。
- **只把 `Ingress` 挪到 `Mailbox` 前面。** `ingress` 依赖频道和工单，挪不动；问题是表的名字和写它的人对不上。
- **大模块拆成几个服务。** 几块读同一个帮工、同一份记账，拆成服务要么互相依赖、要么各存一份；内部的工厂只是把闭包分开，状态仍然一份。

## Consequences

- 加一个概念：在 `packages/protocol/src/<概念>/` 写三个文件，在三份汇总里各加一行，在 `http/handlers/<概念>.ts` 实现；不再碰别的概念的文件。
- 三个大服务的文件：`issue.ts` 1438 → 533 行，`channel.ts` 1511 → 765 行，`session.ts` 1420 → 694 行；对外的服务和测试都没变。
- `packages/health` 读盘上的文件时也算还没提交的新文件，不读已删掉还没提交的，所以新加的文件从一开始就在棘轮里。

## Verification

- `vp check`、`vp run server:check`、`vp run web:check`、`vp run effect:check`、`vp run deadcode`、`vp run health:verify`、`vp run docs:verify` 通过。
- 工单、频道、帮工、信箱、Inbox 和流程的测试照常；`api:client` 生成的客户端除了接口的先后不变。
- 拆开以后时间变了，两条读「交了没看」的测试原来靠库写得慢才过：频道测试里扮演的帮工改成一轮放行时才读它的输入（停住的一轮没读，重启后再交一次），`flows/talk.test.ts` 的 regression 改成比时间（交出 ≤ 那一轮开始 ≤ 看到），不再在中间抓一个状态。
