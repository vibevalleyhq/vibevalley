# Agent Note: 状态先提交，副作用由 worker 在提交之后做

Status: proposed

## Problem

服务端已在 [Mailbox](docs/subsystems/mailbox.md)（`mailbox_trigger`、`mailbox_delivery`、`mailbox_issue`）与连接器（`connector_outbox`）实现「同事务落盘、后台投递」，但工单派活、检查合并与外部通知仍存在两处缺口：
- **状态提交与外部动作未同事务持久化**：派活（改 `issue` 表 → 启动 oar `Session`）、完成交付（跑 `.vibevalley/check` → `git merge` / `gh pr create`）和声网通话在请求内串行执行外部 I/O；若写库与外部调用之间进程退出，重启后依赖各模块 `start` layer 按固定顺序修补。
- **多套后台循环各自轮询**：`Mailbox`、`Connector`、`Issue.refreshQueue` 和 `Cron.tick` 各自维护一套轮询与退避重试。

## Proposal

将「状态变更要求执行的外部副作用」统一收进同一张事务表与同一个后台 worker：

1. **统一副作用表（`core_job`）**：列含 `id`、`kind`（各模块登记的封闭联合）、`payload`、`not_before`、`attempts`、`last_error`、`done_at`。业务模块在修改自身表的**同一个数据库事务**内插入 `core_job` 行，提交后调 `Core.apply` 发布事实并立即唤醒 worker。
2. **幂等处理函数与退避重试**：worker 按 `not_before` 认领未完成行，在事务外执行外部子进程与网络 I/O，成功写 `done_at`，失败指数退避重试；各处理函数按 `id` 幂等（先查已有同名 oar 会话或已开放的分支 PR）。
3. **收敛现有循环**：先迁入「派活开 `Session`」和「完成合并 / 提 PR」，再将 `connector_outbox` 等轮询合入同一 worker；重启直接按行依赖续跑。

## Alternatives considered

- **全量事件溯源**：需重写全部现有业务表与查询；现有业务表已是唯一真相，仅缺外部副作用同事务落盘。
- **引入 `@effect/workflow` / cluster**：对当前单连接 Postgres / PGlite 架构过重，一张 `core_job` 表加作用域纤程即可满足。
- **各模块继续各自维护 outbox 表**：每新增一种外部动作就多一套轮询与启动顺序依赖。

## Acceptance criteria

- `core_job` 表与后台 worker 上线；派活、完成交付与连接器发件均在同一事务内写 `core_job` 并由 worker 驱动。
- 每个处理函数重放执行两次结果与执行一次一致；状态已提交、副作用未执行时重启服务端可自动补跑。

## Risks

- `gh pr create` 与 oar 会话启动非天然幂等，迁入前须先在对应模块实现按标识对账逻辑；所有外部 I/O 必须在认领事务外执行以免阻塞单连接写操作。
