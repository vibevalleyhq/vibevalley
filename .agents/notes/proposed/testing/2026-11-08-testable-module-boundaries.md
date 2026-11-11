# Agent Note: 把可控制、可观察和可关闭做成模块边界

Status: proposed

## Problem

模块测试与页面日期测试仍存在以下具体边界缺口（设计准则已沉淀至 [模块设计](docs/style/module-design.md)）：

| 位置 | 现有缺口 | 证据与后果 |
|---|---|---|
| `apps/server/src/executor/executor.ts` | `Executor.observe` 在订阅后才进入 `observing`，oar 游标回放在订阅调用内同步触发 | 迁移基线连跑 20 轮中，Session 组 6 条用例因初始事件与输入回执被守卫丢弃而稳定失败 |
| `packages/testkit/src/until.ts` | 冻结业务 `TestClock` 时，若 `waitFor` 的 `getter` 自身挂起，等待器内部期限不触发 | 仅靠外层 500ms 兜底退出，缺少独立于 `getter` 的真实时间 watchdog |
| `packages/agent/src/testing/testing.ts` | `withAgent` 默认用 `Date.now()` 构造消息，`ask` 靠固定两次 `yieldNow` 等待订阅者消费 | 输入与 `Brain` 的 `Effect.Clock` 不在同一时间线；同刻提醒碰撞与 `Session.host` 关闭作用域已修，消费等待仍待收口 |
| `apps/server/src/testing/world.ts`、`worker.ts` | 默认装配装入真实 `FetchHttpClient.layer` 与 `Llm.layer`；`installedOnly` 用墙钟生成 `checkedAt`；工单与频道模块测试仍依赖整座 `world()` | 意外外呼未被默认端口拒绝；测试探测时间不随 `TestClock` 推进；尚未用窄 `Mailbox` 替身隔离单模块测试 |
| `apps/server/src/modules/cron/cron.test.ts` | 以 `drained = aTurn` 代替目标事件或提交确认等待 | 一轮事件循环不能证明异步消费者与周期驱动已完成 |
| `apps/web/src/features/pkm/Calendar.tsx` | 创建时一次性读取「今天」 | 实机验证将浏览器时间从 `2026-12-31 23:59:59` 拨至 `2027-01-01 00:00:01` 并触发可见性恢复后，仍高亮旧日期 |
| `vite.config.ts` | 对全部测试与 `testing/` 目录整体关闭 `vibevalley/no-wall-clock` | 测试夹具默认时间输入不受共享时钟门禁约束 |

## Proposal

在不改变 HTTP 契约、表结构及既有重试/去重政策的前提下，分六个纵向切片收口：

1. **agent 夹具与提醒边界（`packages/agent`）**：`withAgent` 默认消息时间改读测试 `Clock`（历史消息允许显式传参）；订阅先于 `ask` 建立，按公开 `progress().current` 匹配并等待目标运行的 `agent_settled`，删除固定两次 `yieldNow` 假设；补期限边界、错过期限恢复与关闭后不再唤醒测试。
2. **Session 与 Executor 并发收尾（`apps/server/src/modules/session`、`executor`）**：修复 `Executor.observe` 先立观察身份再订阅回放，拒绝旧观察器迟到回调；在脚本 runtime 边界用 `gate` 构造「开启未返回时取消」「取消后迟到成功」「`dispose` 失败后再次派活」三种交错；补 `infra/time.ts` 的 `sleep` 中断与 `Scope` 关闭契约测试。
3. **Cron 与 Mailbox 恢复及驱动接线（`apps/server/src/modules/cron`、`mailbox`）**：去掉 `drained = aTurn`，改为等待目标状态或持久化记录；补提交前失败、提交后路由失败、停机重建恢复，以及至少一条由真实 `Cron.start` 周期驱动触发（非手调 `tick`）的测试。
4. **测试装配隔离与窄替身（`apps/server/src/services.ts`、`testing/`、`packages/testkit`）**：分离领域服务组合与外部端口接入，测试默认注入拒绝意外远程请求与模型调用的端口，`installedOnly` 改读环境 `Clock`；为 `Channel` 与 `Issue` 各提供至少一组基于窄 `Mailbox` 替身、无需 `world()` 的模块测试；为 `waitFor` 增加覆盖挂起 `getter` 的真实时间 watchdog 与有界诊断。
5. **PKM 本地日期订阅（`apps/web/src/infra`、`features/pkm/Calendar.tsx`）**：纯日期函数显式收 `now`；在 `infra` 提供浏览器本地自然日订阅（跨午夜与页面恢复可见时刷新，无订阅者时清理定时器与监听），不覆盖用户主动选定的查看月份。
6. **收紧门禁与实测对账（`vite.config.ts`、`scripts/audit/oxlint-plugin.ts`）**：缩小 `no-wall-clock` 在测试与夹具上的豁免（放行 `new Date(timestamp)` 与窄边界保护）；按迁移前同一基线（串行与默认并发各连跑 20 轮，`--retry=0`）复测 `agent`、`Session`、`delivery` 三组耗时与稳定性，沉淀至 [地基](docs/subsystems/foundation.md) 与 [客户端](docs/subsystems/app.md) 后删除本 Note。

## Alternatives considered

- **只把 `Date.now` 机械换成 `Clock` 或全量换 `it.effect`**：无法表达订阅就绪与关闭完成契约，且真实 git/数据库边界仍需独立的真实时间防挂死保护。
- **新建万能 `TestHarness` 与全局 `settleEverything()`**：后台巡查无统一空闲点，再包一层浅入口只会复制生产装配顺序。
- **把本机 git 与数据库全换成内存 mock**：会丢掉事务回滚、文件原子替换与 worktree 引用更新的真实边界覆盖。
- **靠拉长超时、开启重试或全局串行通过测试**：会掩盖共享状态泄漏、回放顺序缺陷与缺失的完成信号。

## Acceptance criteria

- `Executor.observe` 游标回放与迟到关闭交错修复后，Session、agent、delivery 三组在串行与默认并发下连跑 20 轮（`--retry=0`）零失败，且既有 `regression: ` 断言不放松。
- 测试默认装配对未声明的 HTTP 与模型调用立即报错；两套不同 epoch 与脚本队列的测试环境并行运行不串状态；`Channel` 与 `Issue` 各有不依赖 `world()` 的窄 `Mailbox` 模块测试。
- 冻结业务 `TestClock` 且 `getter` 挂起时，`waitFor` 仍按自身真实时间上限失败退出并清理资源。
- `PKM` 日历在跨午夜、跨月/年及后台恢复可见时自动更新「今天」且保留用户所选月份，卸载后无残留监听。
- `no-wall-clock` 测试豁免收窄并补正反例单测；`vp check --deny-warnings`、`vp run server:check`、`vp run web:check`、`vp run deadcode` 与 `vp run docs:verify` 全部通过。

## Risks

- **Layer 捕获顺序错位**：`TestClock` 固定起点与拒绝端口必须在服务捕获依赖前注入，需用非零固定 epoch 与并行双环境测试验证实际生效。
- **观察确认反客为主**：订阅确认只能做在测试观察器或外部替身侧，不得把生产异步事件流改成阻塞等待消费者。
