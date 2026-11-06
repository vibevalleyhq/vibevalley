# Ingress

`Ingress` 是输入流水线的第一层：将 GitHub PR 事件、外部聊天连接器、语音通话等异构外部输入校验、去重并标准化为不可变的 `Trigger`，写入 `mailbox_trigger` 后交由 [Mailbox](docs/subsystems/mailbox.md) 路由投递。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 外部事件（GitHub CI/Review、连接器、语音、电话播报）的 Schema 校验、按 `(source, key)` 幂等去重与标准化 | 收件人路由、三道刹车与会话唤醒（[Mailbox](docs/subsystems/mailbox.md)） |
| GitHub PR 检查、评审与行内评论的分页拉取、指纹比对（`ingress_github`）与机器人评审轮次归并（`botRoundKey`） | 工单状态流转与 PR 合并/关闭结局判定（[工单](docs/subsystems/issue.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/ingress/ingress.ts` | `Ingress` 服务（`accept`、`owner`、`record`、`say`）与幂等去重 |
| `apps/server/src/ingress/github.ts` | GitHub GraphQL/REST 分页拉取、CI 指纹（`ingress_github` 表）与评审线程归一化 |
| `apps/server/src/mailbox/payload.ts` | 将标准化后的 `Trigger` 与原始载荷写入 `mailbox_trigger` 表 |

## 模型和不变量

- **一个 `(source, key)` 只产生一条 `Trigger`**：重复到达的外部事件直接返回已存 `Trigger`，不重复写库或触发下游路由。
- **控制头与原始载荷分离且不可变**：
  - `TriggerMeta` 与 `TriggerContext` 经协议 Schema 严格解码。
  - 大段原始文本或结构化数据存入同行独立的 payload 列，写入后只读（供 `vv://trigger/<id>` 按需分页拉取）。
- **GitHub 快照完整性与同轮评审归并**：
  - 拉取 PR 的检查、评审、评论与评审线程时，任一分页请求失败即放弃本次快照，不将残缺列表当成空结果。
  - 同一次 Review 及其附带的多条行内评论共享同一个 `botRoundKey`，只消耗一次 `maxBotReviewRounds` 额度。
  - 失败的 Actions 检查若带 job 链接，轮询时用 `gh run view --job <id> --log-failed --repo <owner/name>` 取回末尾 40 行，和检查名一起交给帮工。

## 怎么走

1. 外部来源产生 `SourceEvent`（连接器/语音调用 `Ingress.owner`，GitHub 轮询调用 `refreshGitHub`）。
2. `Ingress.accept` 按 `(source, key)` 去重，调用 `keepSourceTrigger` 写入 `mailbox_trigger`。
3. 调用 `Mailbox.receive` 推进路由；若进程在写库后、路由前退出，下次启动或轮询时自动重放未路由的 `Trigger`。

## 和谁打交道

- **信箱、频道与项目（`mailbox`、`channel`、`project`）**：通过 `Project` 调 `gh` 接口，通过 `Channel` 落库主人消息，将 `Trigger` 交给 `Mailbox`。
- **资源（`resource`）**：向 `Resource.read` 提供 `vv://trigger/<id>` 与 `vv://github/...` 线程载荷读取。

## 为什么这样

- **入口只标准化一次，原因与大载荷分离**：七种异构来源在入口处统一收敛为带类型的 `Trigger`；大段 GitHub diff 留在 payload 列按需拉取，保持投递队列轻量。

## 怎么验证

- `apps/server/src/ingress/ingress.test.ts`、`apps/server/src/flows/ingress.test.ts`：`(source, key)` 幂等去重、GitHub CI 指纹变化、同轮 Review 归并与断点重放测试。
