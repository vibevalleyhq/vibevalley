# Ingress

## 一句话

把 GitHub、连接器、语音等外部输入读成 `Trigger`；内部派工、定时与巡查由所属模块直接交给 Mailbox。

## 管什么，不管什么

- **管**：来源的校验、去重、触发者/收件人/回复位置的标准化；读成的 Trigger 经信箱的 `keepSourceTrigger` 记进 `mailbox_trigger`（表归信箱：派工、定时、巡查的 Trigger 也记在那里）。
- **不管**：谁该听到、叫不叫醒（[信箱](docs/subsystems/mailbox.md)）、工单怎么变（[工单](docs/subsystems/issue.md)）、会话怎么跑（[帮工](docs/subsystems/session.md)）。

## 在哪

- `apps/server/src/ingress/ingress.ts` 是服务；`github.ts` 把 PR 检查和评审读成事件；聊天由 Channel 的 `route.ts` 标准化。
- Trigger 与 payload 存在信箱的 `mailbox_trigger`；来源自己的观察位置在 `ingress_github` 等表。
- 入口是 `Ingress.accept`（一条来源事件）、`Ingress.owner`（主人的话）、`Ingress.record`（只记下不派发）；状态帧里的 `StateFrame` 不直接暴露它。

## 模型和不变量

- **一个 Trigger 只产生一次**：`(source, key)` 唯一；重复读到的来源事件返回已有 Trigger，不再写库。
- **控制字段有类型**：`TriggerMeta` 与 `TriggerContext` 的字段由 protocol 的 Schema 解码；来源原始数据只放 payload。频道只提供投递需要的元数据，不复制整份消息元数据。
- **载荷不可变**：`text`/`data` 与 Trigger 在同一行的不同列保存，之后的处理只读。
- **不替别人做决定**：Trigger 的 `addressed`、`threads` 只是来源给的地址，真正的路由和刹车在 Mailbox。

## 怎么走

1. 来源产生 `SourceEvent`；`Ingress.accept` 校验并去重。
2. 经 `keepSourceTrigger` 写进 `mailbox_trigger`，把 `Trigger` 交给 Mailbox。
3. GitHub 由 `refreshGitHub` 周期拉取；连接器/语音由 `owner` 或 `say` 进入。
4. 未路由的持久信件由 Mailbox 重放；聊天消息由 Channel 重放并重新计算受众。Ingress 不推进工单排队。

## 和谁打交道

- 依赖 Channel（主人说的话）、Mailbox（路由）、Issue/Project（来源对应的实体）。
- Resource 经 `read` 拉取载荷。Mailbox、Issue 使用 protocol 的 Trigger 形状，不依赖 Ingress 服务。
- 反向只经 `Trigger` 形状和数据库，不 import 上层。

## 为什么这样

- **来源只标准化一次。** 七个入口各写一套校验和去重，规则会分叉；一张 Trigger 让后面只认一种输入。
- **原因和载荷分开。** 去重只需要 `(source, key)`；把大段 GitHub/聊天载荷放同一列会让 Trigger 查询变重。

## 怎么验证

- `ingress/ingress.test.ts`、`flows/ingress.test.ts`、`base/base.test.ts`。
