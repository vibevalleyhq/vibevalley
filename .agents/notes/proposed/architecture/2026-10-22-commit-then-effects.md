# Agent Note: 状态先提交，副作用由 worker 在提交之后做

Status: proposed

## Problem

当前服务端虽已在 [Mailbox](docs/subsystems/mailbox.md)（`mailbox_trigger`、`mailbox_delivery`、`mailbox_issue`）与连接器（`connector_outbox`）实现了「先同事务落盘、再后台投递」，但工单派活、检查合并与外部通知仍存在两处缺口：
- **状态提交与外部动作未同事务持久化**：派活（改 `issue` 表 → 启动 oar `Session`）、收获（跑 `.vibevalley/check` → `git merge` / `gh pr create`）和声网通话在同一次请求调用里串行做外部 I/O；若进程在写库与外部调用之间崩溃，重启后需靠各模块 `start` layer 按固定顺序修补。
- **多套后台循环各自轮询**：`Mailbox`、`Connector`、`Issue.refreshQueue` 和 `Cron.tick` 各自维护一套轮询与退避重试逻辑。

## Proposal

不引入全量事件溯源，只将「状态变更要求执行的外部副作用」统一收进同一张事务表与同一个后台 worker：

1. **统一副作用表（`core_job`）**：列含 `id`、`kind`（各模块登记的封闭联合）、`payload`、`not_before`、`attempts`、`last_error`、`done_at`。业务模块在修改自身表的**同一个 SQLite 事务**内插入 `core_job` 行，事务提交后调用 `Core.apply` 发布事实并立即唤醒 worker。
2. **幂等处理函数与退避重试**：worker 按 `not_before` 取出未完成行执行，成功写 `done_at`，失败指数退避重试；各处理函数必须按 `id` 幂等（如检查已有同名 oar 会话或已开放的分支 PR）。
3. **收敛现有循环并解耦启动顺序**：先将「派活开 `Session`」和「收获合并 / 提 PR」迁入 `core_job`，再将 `connector_outbox` 等独立轮询合入同一 worker；重启恢复直接由 worker 按行上依赖顺序续跑未完成任务。

## Alternatives considered

- **全量事件溯源（所有业务表改为事件日志投影）**：需重写工单、频道、稿子等全部现有 SQLite 表与查询；现有业务表已是唯一真相，仅缺外部副作用与状态同事务落盘。
- **引入 `@effect/workflow` / cluster**：需要额外的持久化运行时，对单进程 `node:sqlite` 服务端过重；一张 `core_job` 表加一个纤程循环即可满足。
- **各模块继续各自维护 outbox 表**：每新增一种外部动作就多一套轮询与启动顺序依赖。

## Acceptance criteria

- `core_job` 表与后台 worker 上线；派活、收获与连接器发件均在同一事务内写 `core_job` 并由 worker 驱动。
- 每个 `core_job` 处理函数在测试中重放执行两次（模拟做完前崩溃），结果与执行一次完全一致。
- 流程测试覆盖「状态已提交、外部副作用未执行时重启服务端」，重启后自动补派帮工或补提 PR。

## Risks

- `gh pr create` 与 oar 会话启动非天然幂等，迁入前必须先在对应模块实现「查询是否已创建」的对账逻辑。
- SQLite 单写连接下，所有外部子进程与网络 I/O 必须严格在 `core_job` 认领事务之外执行。
