# Agent Note: 等待器真实时间上限、模块窄替身与测试时钟门禁收窄

Status: proposed

## Problem

设计准则在 [模块设计](docs/style/module-design.md)。当前服务端测试边界与存量实践棘轮仍有五处缺口：

| 位置 | 缺口 | 后果 |
|---|---|---|
| `packages/testkit/src/until.ts` | `waitFor` 每轮先裸 `await get()` 再检查 `deadline`；`get()` 自身挂起时期限永远不检查 | 只能等整条 vitest 用例超时退出，报错不说在等什么；同文件的 `within(p, ms, what)` 未被 `waitFor` 复用 |
| `apps/server/src/modules/watch/watch.test.ts`（原 `channel/channel.test.ts`）、`apps/server/src/modules/repo/repo.test.ts` | `watch.test.ts` 直接穿透引用 `#/modules/session/mailbox.ts` 与 `history.ts` 搭测试环境；`repo.test.ts` 每次测合并门禁都在新 worktree 下拉起真实 `.vibevalley/check` shell 子进程 | 模块单测与相邻模块的内部实现或外部子进程强绑定，边界重构易碎且耗时偏高 |
| 根目录 `vite.config.ts` | `vibevalley/no-wall-clock` 对 `apps/server/src/**/*.test.ts`、`packages/*/src/**/*.test.ts`、`apps/server/src/testing/**`、`packages/*/src/testing/**` 整块关掉 | 夹具里的默认时间随手读墙钟而不随测试时钟推进，规则在测试里形同虚设 |
| `scripts/audit/practice.ratchet.json` | 仍保留 `turn-as-absence`（`apps/server: 1`、`packages/bridge: 1`）与 `duplicated-setup`（`apps/server: 3`）存量豁免 | 事件循环单轮等待充当否定断言边界，重复大对象夹具散落多处 |

## Proposal

1. **等待器带真实时间上限**：`waitFor` 每次 `get()` 都经 `within` 限在剩余期限内，超时报 `waited for <what>`，`get` 永不返回时也一样；`untilGot`、`until`、`whenTrue` 同步获得这条保证，并补一条 `get` 挂起的单测。
2. **模块窄替身与检查端口隔离**：
   - 为 `channel.test.ts` 提供面向 `Session` 对外接口的窄测试替身，消除对 `#/modules/session/mailbox.ts` 与 `history.ts` 内部文件的穿透导入（跨模块路由与恢复留给 `session` 自身测试及 `src/flows`）。
   - 将 `repo/check.ts` 的 `.vibevalley/check` 执行作为可注入端口传给 `makeRepo`：真实 shell 脚本仅在 `check.ts` 专属测试中运行，合并与 PR 模块测试注入内存检查替身验证并发竞态与失败截断。
3. **收窄时钟门禁**：`vite.config.ts` 里测试和夹具的豁免改为只放行 `new Date(timestamp)` 这类不读当前时刻的写法（仅 `packages/testkit`、`infra/time.ts` 与 `realTime.ts` 可读真实时钟），夹具默认时间统一走测试时钟，并在 `scripts/audit/oxlint-plugin.test.ts` 补齐正反例。
4. **清零 `turn-as-absence` 存量（4.）**：将剩余两处「`await nextTurn()` 后断言未发生」改为等待已完成操作、替身确认步或推进测试时钟窗口后再断言，将棘轮清零。
5. **清零 `duplicated-setup` 存量（5.）**：把 `apps/server` 剩余 3 处重复的 6 属性以上配置/夹具字面量收拢为就近辅助函数，仅传入差异项，将棘轮清零。

## Alternatives considered

- **新建通用的全局 `TestHarness` 和 `settleEverything()`**：后台巡查无统一空闲点，再包一层只是把 `services.ts` 的 `buildModules` 复制一遍（现已有共享的 `moduleWorld` 与 `world`）。
- **把本机 git 和数据库也换成内存替身**：会丢掉事务回滚、文件原子替换和 worktree 引用更新这些最易出错的真实边界；只把外部 `.vibevalley/check` 子进程抽成可替换端口。
- **拉长超时、开重试或全局串行**：只会掩盖共享状态泄漏和缺失的完成信号。

## Acceptance criteria

- `get` 挂起时 `waitFor` 在自身期限内抛出 `WaitTimedOut` 并写明等待对象。
- `channel.test.ts` 不再导入 `modules/session/` 内部子文件；合并与 PR 模块测试注入内存检查替身，不再重复拉起 shell 子进程。
- `no-wall-clock` 在测试和夹具中不再整块关闭，附正反例单测；`turn-as-absence` 与 `duplicated-setup` 在 `practice.ratchet.json` 中清零。
- `vp check`、`vp run server:check`、`vp run practice:check`、`vp run deadcode` 与 `vp run docs:verify` 全部通过，沉淀进 [地基](docs/subsystems/foundation.md) 与 [模块设计](docs/style/module-design.md) 后删除本 Note。

## Risks

- **收窄时钟门禁一次报出多处存量测试**：按目录分批将夹具默认时间改为读取注入时钟，过渡期仅豁免尚未改完的具体文件而非通配符。
- **内存检查替身与真实脚本返回漂移**：替身复用与 `repo/check.ts` 相同的返回联合类型与 `MergeFailure` 构造器。
