# Agent Note: 仓库检查端口隔离与测试时钟门禁收窄

Status: proposed

## Problem

设计准则在 [模块设计](docs/style/module-design.md)。在等待器真实时间上限、模块单测边界门禁与 `turn-as-absence` / `duplicated-setup` 棘轮清零落地后，当前服务端测试边界仍剩两处缺口：

| 位置 | 缺口 | 后果 |
|---|---|---|
| `apps/server/src/modules/repo/repo.test.ts` | 每次测合并门禁都在新 worktree 下拉起真实 `.vibevalley/check` shell 子进程 | 合并与 PR 测试同外部子进程强绑定，耗时偏高 |
| 根目录 `vite.config.ts` | `vibevalley/no-wall-clock` 对 `apps/server/src/**/*.test.ts`、`packages/*/src/**/*.test.ts`、`apps/server/src/testing/**`、`packages/*/src/testing/**` 整块关掉 | 夹具里的默认时间随手读墙钟而不随测试时钟推进，规则在测试里形同虚设 |

## Proposal

1. **检查端口隔离**：将 `repo/check.ts` 的 `.vibevalley/check` 执行作为可注入端口传给 `makeRepo`：真实 shell 脚本仅在 `check.ts` 专属测试中运行，合并与 PR 模块测试注入内存检查替身验证并发竞态与失败截断。
2. **收窄时钟门禁**：`vite.config.ts` 里测试和夹具的豁免改为只放行 `new Date(timestamp)` 这类不读当前时刻的写法（仅 `packages/testkit`、`infra/time.ts` 与 `realTime.ts` 可读真实时钟），夹具默认时间统一走测试时钟，并在 `scripts/audit/oxlint-plugin.test.ts` 补齐正反例。

## Alternatives considered

- **新建通用的全局 `TestHarness` 和 `settleEverything()`**：后台巡查无统一空闲点，再包一层只是把 `services.ts` 的 `buildModules` 复制一遍（现已有共享的 `moduleWorld`、`playedSessions` 与 `world`）。
- **把本机 git 和数据库也换成内存替身**：会丢掉事务回滚、文件原子替换和 worktree 引用更新这些最易出错的真实边界；只把外部 `.vibevalley/check` 子进程抽成可替换端口。
- **拉长超时、开重试或全局串行**：只会掩盖共享状态泄漏和缺失的完成信号。

## Acceptance criteria

- 合并与 PR 模块测试注入内存检查替身，不再重复拉起 shell 子进程。
- `no-wall-clock` 在测试和夹具中不再整块关闭，附正反例单测。
- `vp check`、`vp run server:check`、`vp run practice:check`、`vp run deadcode` 与 `vp run docs:verify` 全部通过，沉淀进 [地基](docs/subsystems/foundation.md) 与 [模块设计](docs/style/module-design.md) 后删除本 Note。

## Risks

- **收窄时钟门禁一次报出多处存量测试**：按目录分批将夹具默认时间改为读取注入时钟，过渡期仅豁免尚未改完的具体文件而非通配符。
- **内存检查替身与真实脚本返回漂移**：替身复用与 `repo/check.ts` 相同的返回联合类型与 `MergeFailure` 构造器。
