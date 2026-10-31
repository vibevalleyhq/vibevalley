# packages/health

`@vibevalley/health`：给一个 git 仓库做体检。读数只指出先看哪里，不判代码好坏；只有逃生口是棘轮，变多了检查失败。它不认识 VibeValley：算哪些文件、怎么分区、哪些文件本来就热，由仓库自己的配置给（这个仓库的是 `scripts/health.config.ts`），以后可以拿去给主人的项目做体检。

- `readings.ts`：纯函数。`underTodaysNames` 把改过名的文件的旧改动记到今天的名字上；`hotspots` 是一个窗口里的改动次数乘行数，和前一个窗口比，一次动了超过 `mechanicalFiles` 个文件的改动算机械的、不计；`escapesIn`、`escapesByArea` 数非空断言（`x!`）、转型（`as T`，`as const` 和转成 `unknown` 不算）、经 `unknown` 的转型（`as unknown as`）、关掉 lint 的注释，和错误通道的三种：`Effect.orDie`/`orDieWith`（错误变成缺陷）、`Effect.ignore`/`ignoreCause` 不带 `{ log }`（错误被悄悄丢掉；带 `{ log }` 的会记下来，不算）、什么也不做的 `catch {}` 和 `.catch(() => {})`（错误被吞掉），以及 `yield* Effect.result(x)`（失败靠手写的 `_tag` 分支回答，类型不再说出处理了哪些错误；用 `Effect.catchTag`、`Effect.match` 代替），用 Vite+ 带的 oxc 解析；`escapeAdvice` 是每种该怎么改，`--check` 报新增时说出来；`drift` 是和棘轮不一样的数，多了少了都算。
- `collect.ts`：读 git 和文件。「现在」是 HEAD 的提交时间，同一个提交在哪台机器上读都一样。
- `cli.ts`、`report.ts`：`vpx packages/health/src/cli.ts --config <配置>`，不带参数出 Markdown 报告，`--json` 出给 agent 读的，`--check` 对棘轮，`--write` 把今天的数记进棘轮。

这个仓库里：`vp run health` 出报告，`vp run health:verify`（CI 的 check 里）跑本包的测试再对棘轮；逃生口少了也失败，跑 `vp run health:write` 把棘轮降下来，和改动一起提交。计划和还没做的几项见 [体检的 Note](.agents/notes/proposed/process/2026-10-29-repo-health-readings.md)。

`resultBranch` 只数 `yield* Effect.result(...)`，不禁止普通 Result 值；改成 `catchTag` 或 `match` 后随同降低基线。文件拆分后仍按领域汇总，不能靠移动文件增加某个区的额度；确实需要的边界转换要在提交说明里解释。
