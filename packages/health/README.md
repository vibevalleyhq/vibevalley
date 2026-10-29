# packages/health

`@vibevalley/health`：给一个 git 仓库做体检。读数只指出先看哪里，不判代码好坏；只有类型逃生口是棘轮，变多了检查失败。它不认识 VibeValley：算哪些文件、怎么分区、哪些文件本来就热，由仓库自己的配置给（这个仓库的是 `scripts/health.config.ts`），以后可以拿去给主人的项目做体检。

- `readings.ts`：纯函数。`underTodaysNames` 把改过名的文件的旧改动记到今天的名字上；`hotspots` 是一个窗口里的改动次数乘行数，和前一个窗口比，一次动了超过 `mechanicalFiles` 个文件的改动算机械的、不计；`escapesIn`、`escapesByArea` 数非空断言（`x!`）、经 `unknown` 的转型（`as unknown as`）和关掉 lint 的注释，用 Vite+ 带的 oxc 解析；`drift` 是和棘轮不一样的数，多了少了都算。
- `collect.ts`：读 git 和文件。「现在」是 HEAD 的提交时间，同一个提交在哪台机器上读都一样。
- `cli.ts`、`report.ts`：`vpx packages/health/src/cli.ts --config <配置>`，不带参数出 Markdown 报告，`--json` 出给 agent 读的，`--check` 对棘轮，`--write` 把今天的数记进棘轮。

这个仓库里：`vp run health` 出报告，`vp run health:verify`（CI 的 check 里）跑本包的测试再对棘轮；逃生口少了也失败，跑 `vp run health:write` 把棘轮降下来，和改动一起提交。计划和还没做的几项见 [体检的 Note](.agents/notes/proposed/process/2026-10-29-repo-health-readings.md)。
