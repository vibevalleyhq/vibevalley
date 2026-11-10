# Agent Note: 收敛概念、契约表面与跨模块链路

Status: proposed

## Problem

截至 2026-11-10，仓库的认知负担主要来自跨模块透传链路与过宽的公共契约表面，而非缺少词法白名单：

- **协议包表面失控**：`packages/protocol/src`（不含生成的 `client.ts` 与测试）共导出 771 个具名声明。其中 250 个从未在包外按名引用（仅用于包内 `shapes.ts`、`schema.ts`、`api.ts` 互引，如 `BlockOpInsertBlock`、`SpanMarks`、`*Endpoints`）；另有 195 个仅有 `apps/server` 引用、无任何客户端消费（如整个 `packages/protocol/src/mailbox/shapes.ts` 及服务端专用的 `Fact*`、`ServerEvent*` 子类型）。
- **单条消息链路经历 10 次形状转换与 5 套身份表示**：一条频道发言从入站到唤醒助手横跨 5 个服务，依次转换为 `SayRequest` → `UserInput` → `PostOf<"User">` → `MsgRow` → `ChannelEnvelopeRow` + `ChannelHearers` → `TriggerInput` → `Trigger` → `DeliveryDraft` / `DeliveryRow` → `Envelope` → `Handed` → `Intake` → `Route` → `Hosted<Route>`。同一链路把「谁做的」拆成 5 种结构：`Actor`（`apps/server/src/base/actor.ts`）、`TriggerActor`（`packages/protocol/src/mailbox/shapes.ts`）、`StoredSenderKind`（`channel_participant.kind`）、`ActorKind` + `AgentRole`（`fromKind` / `fromRole`）与 `Route.user: boolean`。
- **单调用方顶层服务与四路并行事件流**：在 `apps/server/src/services.ts` 的 31 个 `Context.Service` 中，`scripts/service-paths.json` 显示 7 个服务仅有单一内部模块调用方（`Storage` → `attachment`、`Resource` → `tool`、`Machine` → `session`、`User` → `lan`、`Library` → `tool`、`Media` → `tool`、`Orchestrator` → `voice`），而 `Ingress` 不持有任何库表，仅向 `Mailbox` 与 `Channel` 转发调用。同时 `Core` 暴露 6 个流接口，外加 `Session.news`、`Mailbox.news`、`Channel.userInThread` 三条旁路流，`apps/server/src/issue/issue.ts` 需同时订阅 3 条流才能拼齐联动；`packages/protocol/src/core/shapes.ts` 还重复定义了同负载的 `ServerEvent*` 与 `LiveEvent*` 变体。
- **概念表多源维护与高危同名异义**：[概念](docs/concepts.md)、[文档地图](docs/README.md#用语)与 [概念映射表](docs/reference/concept-map.md) 三处重复维护术语与代码名；工单交付结果 `Delivery` 与信箱投递表 `mailbox_delivery` 同名异义，`status`、`phase`、`stage`、`state` 混指状态。

## Proposal

### 1. 两层概念预算与契约包瘦身

- **控制一等概念在 12 个以内**：[概念](docs/concepts.md)与 `packages/protocol` 顶层目录只保留用户可见的一等概念（`Space`、`Repo`、`Agent` / `Skill` / `Runtime`、`Issue`、`Session` / `Run`、`Channel` / `Message` / `Attachment`、`Artifact`、`PkmPage`、`Memory`、`Cron`，以及多机上线后的 `Machine`）。内部传输记录（`Trigger`、`Envelope`、`Fact`、`Outbox`）归入对应子系统内部，不再升格为全局概念。
- **下沉服务端私有形状与包内辅助类型**：将零客户端引用的 `packages/protocol/src/mailbox/` 迁回 `apps/server/src/mailbox/`；取消 `packages/protocol` 桶文件对 250 个包内辅助类型与 `*Endpoints` 的重导出，只导出跨端契约根类型。
- **单源化概念表**：保留 [概念](docs/concepts.md) 作为唯一手写概念源，删除 [文档地图](docs/README.md#用语)中的重复定义列，[概念映射表](docs/reference/concept-map.md) 只映射上述一等概念。

### 2. 收拢单调用方与纯透传服务

- **收紧顶层服务准入**：新模块默认写成子目录纯函数或父模块内部文件；仅当模块同时拥有独立持久化或进程生命周期，且存在至少 2 个业务模块调用方时，才应注册为顶层 `Context.Service`。
- **内聚单调用方基础设施**：将 `Storage` 并入 `apps/server/src/attachment/`；将 `Resource` 并入 `apps/server/src/tool/`；在 [一个服务端管多台机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md) 拆出独立 `apps/machine` 前，将 `Executor` 收为 `apps/server/src/machine/` 的内部实现。
- **拆解纯透传门面 `Ingress`**：用户发言直走 `Channel.post`，触发留痕直走 `Mailbox`，GitHub PR 轮询迁回 `apps/server/src/repo/`，移除 `apps/server/src/ingress/`。

### 3. 三跳形状预算、统一横切类型与定点消歧

- **限制跨模块链路不超过三跳**：端到端链路最多保留三层形状——入站请求（`SayRequest`）、领域记录（`Message` / `Envelope`）、执行输入（`AgentHost` 入参）。`apps/server/src/orchestrator/orchestrator.ts` 应直接把 `Mailbox` 产出的 `Handed` 传给 `AgentHost<Handed>`，删除中间包装形状 `Intake` 与 `Route`。
- **统一身份类型 `Actor`**：在 `packages/protocol/src/common/` 定义唯一 `Actor`（`user` | 带 `id` 与 `role` 的 `agent` | `system`），替换 `TriggerActor`、`StoredSenderKind`、`fromKind` + `fromRole` 与 `Route.user`；将频道成员权限角色与发言者身份拆开存储。
- **统一事件模型与订阅入口**：在 `packages/protocol/src/core/shapes.ts` 将 `ServerEvent` 定义为 `Fact | ServerEventSnapshot | LiveEvent`，删除重复的 `ServerEventStep`、`ServerEventNotice`、`ServerEventRuntime`。服务端跨模块状态联动应统一订阅 `Core.transitions`（`{ before, fact, after }`），不应再新增旁路 `PubSub`。
- **定点消除高危撞名**：工单合并结果 `Delivery` 改名 `Landing`（与信箱 `mailbox_delivery` 解撞）；约定人工设定叫 `status`、程序推进叫 `phase`、派生展示叫 `stage`、完整快照叫 `state`；删除无生产调用的死类型 `TriggerKind`；将农机界面英文词与机器 `Machine` 解撞。

### 4. 用结构棘轮替代词干审批，分三批推进

用 3 条确定性结构检查守住边界：
1. **协议导出数棘轮**：统计 `packages/protocol` 导出声明总数并写入棘轮基线，只减不增。
2. **协议跨端引用检查**：除 endpoint 定义外，`packages/protocol` 不应导出仅有 `apps/server` 引用的类型。
3. **服务扇入检查**：扩展 `scripts/service-paths.ts`，新增单调用方顶层 `Context.Service` 时报错。

按持久化影响从零到有分三批落地：
1. **第一批（零 SQL 迁移）**：清理 `packages/protocol` 包内重导出、将 `packages/protocol/src/mailbox/` 迁回服务端、删除 `Orchestrator` 的 `Intake` 与 `Route`、合并 `ServerEvent` 重复变体、接入协议导出数棘轮。
2. **第二批（收敛服务图）**：内聚 `Storage`、`Resource`、`Executor`，拆解 `Ingress` 并同步收紧 `scripts/service-paths.json`。
3. **第三批（横切模型与表字段迁移）**：统一 5 处 `Actor`、将工单 `Delivery` 改为 `Landing`，按单概念拆独立提交推进。

## Alternatives considered

- **基于 AST 驼峰拆词与约 700 词白名单逐词审批（取代原 `2026-11-10-vocabulary-of-concepts.md`）**：原提案通过拆解 `packages/protocol` 导出名的词干拦截未批概念，但词法合法无法阻止结构透传——用已批准的 `Channel`、`Trigger`、`Delivery`、`Envelope`、`Route` 仍会拼出 10 跳转换链与单调用方服务，且缩写、动词变形与外部协议词会持续制造白名单维护噪音。本 Note 取代原提案，保留原提案识别出的高危撞名（`Delivery`、`Actor`、`ServerEvent`、`status` / `phase`、`TriggerKind`），将门禁从「审词干」改为「卡协议表面与服务扇入」。
- **一次性改齐所有局部同义字段（如 `rev` / `revision`、`position` / `rank` / `order_key`）**：模块私有表列和局部字段不跨公共契约传染，集中改表列会带来存盘迁移风险与大面积无行为收益的改动；局部命名宜在触及对应模块时顺手统一。
- **取消服务分层、合并为单一模块**：拍平所有模块会破坏 `scripts/service-paths.json` 守住的有向无环依赖图；只需内聚单调用方薄层与无自有表的透传门面。

## Acceptance criteria

- `packages/protocol` 导出声明总数较 771 基线下降至少 45%，`packages/protocol/src/mailbox/` 迁入 `apps/server/src/mailbox/`，协议包内无零外部引用或纯服务端私有的非契约类型。
- 频道发言到唤醒助手的跨文件形状不超过 3 种，`Intake`、`Route`、`TriggerKind` 与重复的 `ServerEvent*` 变体从源码删除并记入 `scripts/stale-names.ts`。
- `Storage`、`Resource`、`Ingress` 从 `apps/server/src/services.ts` 移除；协议表面与服务扇入棘轮接入 `vp check` 与 `vp run docs:verify`。
- 同步更新 [概念](docs/concepts.md)、[概念映射表](docs/reference/concept-map.md)与相关子系统文档后删除本 Note。

## Risks

- **存盘数据与客户端契约兼容**：第三批修改 `Actor` 存储字段与工单 `Delivery` → `Landing` 会影响数据库列与客户端解码。应先合入零持久化改动的第一、二批，第三批按单概念拆分迁移提交并保留读取兼容。
- **与多机拆分改造交叉**：收拢 `Executor` 与搬移 `Ingress` 中的 GitHub 轮询会触及 [一个服务端管多台机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md) 涉及的 `Machine` 与 `Repo` 依赖边。执行第二批前应先对齐 `scripts/service-paths.json` 的目标方向，避免重复搬迁。
