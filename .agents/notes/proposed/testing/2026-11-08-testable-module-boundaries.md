# Agent Note: 测试的时钟门禁收窄、频道和工单的窄模块测试、等待器的真实时间上限

Status: proposed

## Problem

设计准则在 [模块设计](docs/style/module-design.md)。测试边界还有三处缺口：

| 位置 | 缺口 | 后果 |
|---|---|---|
| 根目录 `vite.config.ts` | `vibevalley/no-wall-clock` 对 `apps/server/src/**/*.test.ts`、`packages/*/src/**/*.test.ts`、`apps/server/src/testing/**`、`packages/*/src/testing/**` 整块关掉 | 夹具里的默认时间可以随手读墙钟，不随测试时钟走；规则在测试里管不到任何东西 |
| `apps/server/src/modules/issue/issue.test.ts`、`channel/mentions.test.ts`、`channel/channel.test.ts` | 工单和提及的测试搭整座 `world()`（`apps/server/src/testing/world.ts`）；`channel.test.ts` 自己搭一个农场，用的是真的 `makeMailbox` | 没有窄的 `Mailbox` 替身，单测一个模块也要装上邮箱、会话和它们的恢复，失败时分不清错在哪个模块 |
| `packages/testkit/src/until.ts` | `waitFor` 每轮先 `await get()` 再看期限；`get` 自己挂起时期限永远不检查 | 只能靠 vitest 的整条用例超时退出，报错不说在等什么。同一文件的 `within(p, ms, what)` 已经给一个 promise 加真实时间上限，`waitFor` 没用它 |

## Proposal

1. **等待器带真实时间上限**：`waitFor` 每次 `get()` 都经 `within` 限在剩余期限内，超时报 `waited for <what>`，`get` 挂起也一样；`untilGot`、`until`、`whenTrue` 跟着得到这条保证。补一条 `get` 永不返回的测试。
2. **频道和工单的窄模块测试**：在 `apps/server/src/testing/` 加一个只记下收到什么的 `Mailbox` 替身；`Channel` 与 `Issue` 各补至少一组不经 `world()`、只装库、`Core` 和这个替身的模块测试。整座 `world()` 留给 `src/flows` 的跨模块流程。
3. **收窄时钟门禁**：`vite.config.ts` 里测试和夹具的豁免改成只放行 `new Date(timestamp)` 这类不读当前时间的写法（或只豁免 `packages/testkit` 与 `infra/time.ts`）；夹具的默认时间改读测试时钟。`scripts/audit/oxlint-plugin.test.ts` 里给这条规则补正反例。

## Alternatives considered

- **新建一个通用的 `TestHarness` 和全局 `settleEverything()`**：后台巡查没有统一的空闲点，再包一层只是复制一遍生产的组装顺序。
- **把本机 git 和数据库全换成内存替身**：丢掉事务回滚、文件原子替换和 worktree 引用更新这些真实边界。
- **拉长超时、开重试或全局串行**：掩盖共享状态泄漏和缺失的完成信号。

## Acceptance criteria

- `get` 挂起时 `waitFor` 在自己的期限内失败，报错写出在等什么。
- `Channel` 与 `Issue` 各有一组不依赖 `world()` 的模块测试，用窄 `Mailbox` 替身。
- `no-wall-clock` 在测试和夹具里不再整块关掉，规则有正反例测试；`vp check`、`vp run server:check`、`vp run deadcode` 与 `vp run docs:verify` 通过。

## Risks

- **收窄门禁会一次报出很多处**：先列出现有违例，按文件分批改；分批期间可把仍未改的文件写进豁免，改完一批删一批。
- **替身和真邮箱的行为漂移**：替身只记录调用、不模拟路由；路由本身仍由 `mailbox` 自己的测试和 `src/flows` 覆盖。
