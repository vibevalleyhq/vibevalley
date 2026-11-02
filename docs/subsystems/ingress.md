# Ingress

## 一句话

把 GitHub、连接器、频道、定时、巡查和主人说的话读成同一张 `Trigger`，是四层流水线的第一层。

## 管什么，不管什么

- **管**：来源的校验、去重、载荷保存、触发者/收件人/回复位置的标准化，以及 `ingress_trigger` 的读写。
- **不管**：谁该听到、叫不叫醒（[信箱](docs/subsystems/mailbox.md)）、工单怎么变（[工单](docs/subsystems/issue.md)）、会话怎么跑（[帮工](docs/subsystems/session.md)）。

## 在哪

- `apps/server/src/ingress/ingress.ts` 是服务；`github.ts`、`cron.ts`、`channel.ts`、`issue.ts` 各自把来源读成事件。
- 表 `ingress_trigger` 保存原始 Trigger 与 payload；来源自己的观察位置在 `ingress_github` 等表。
- 入口是 `Ingress.accept`（一条来源事件）、`Ingress.owner`（主人的话）、`Ingress.record`（只记下不派发）；状态帧里的 `StateFrame` 不直接暴露它。

## 模型和不变量

- **一个 Trigger 只产生一次**：`(source, key)` 唯一；重复读到的来源事件返回已有 Trigger，不再写库。
- **载荷不可变**：`text`/`data` 与 Trigger 分表保存，之后的处理只读。
- **不替别人做决定**：Trigger 的 `addressed`、`threads` 只是来源给的地址，真正的路由和刹车在 Mailbox。

## 怎么走

1. 来源产生 `SourceEvent`；`Ingress.accept` 校验并去重。
2. 写 `ingress_trigger`，把 `Trigger` 交给 Mailbox。
3. GitHub、定时、巡查由 `refresh*` 主动拉；连接器/语音由 `owner` 或 `say` 进入。
4. 开机时 `start` 恢复观察位置，再把没处理完的来源补齐。

## 和谁打交道

- 依赖 Channel（主人说的话）、Mailbox（路由）、Issue/Project（来源对应的实体）。
- Mailbox、Resource、Issue 依赖它的 Trigger 和 `read` 查询。
- 反向只经 `Trigger` 形状和数据库，不 import 上层。

## 为什么这样

- **来源只标准化一次。** 七个入口各写一套校验和去重，规则会分叉；一张 Trigger 让后面只认一种输入。
- **原因和载荷分开。** 去重只需要 `(source, key)`；把大段 GitHub/聊天载荷放同一列会让 Trigger 查询变重。

## 怎么验证

- `ingress/ingress.test.ts`、`flows/ingress.test.ts`、`base/card.test.ts`。
