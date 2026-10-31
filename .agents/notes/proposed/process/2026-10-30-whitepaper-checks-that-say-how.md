# Agent Note: 白皮书里还没做的：骨架、重复 lint、流切片、常驻集合和体检，各在什么时候做

Status: proposed

## Problem

《AI 智能体时代的软件维护与工程治理白皮书：五层抗熵金字塔体系》（v3.0，外部文档，不进仓库）讲 agent 写代码时代码库怎么变坏、怎么挡。对这个仓库收益最大、马上能做的几项已经上线，理由写在[工程流程](docs/subsystems/process.md)的「为什么这样」：检查失败时说怎么改、死代码由 knip 查、错误通道的逃生口进棘轮、回归测试改了要说。

剩下的几项有收益，但现在不划算：VibeValley 的架构还在成形，契约本身一个月被改几十次，只有一位主人。本篇记下它们是什么、收益在哪、到了什么时候做，免得下次又从头比一遍白皮书。

## Proposal

| 做法 | 收益 | 什么时候做 |
|---|---|---|
| 收回控制流：扩展点只填空（骨架） | agent 碰不到超时、重试、清理，就写不散、写不漏；一次结构上的改动挡住一整类问题 | 和[工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)一起，先做农场的工具（`apps/server/src/tool/tool.ts`，工具还会变多）；connector 的 adapter 各自写超时（10、20、25 秒）和登录的轮询，等这些出了问题再收 |
| 先用已有的：共用帮手的清单 | 每次开工的 agent 不记得仓库里有什么，找不到就再写一份（`testing/git.ts` 有 `gitSync`，十几处测试仍然自己 `execFileSync("git", …)`） | 清单从共用位置（`packages/testkit/src`、`apps/server/src/testing`、`apps/server/src/base`、`apps/server/src/infra`、`apps/web/src/base`、`apps/web/src/infra`、`apps/web/src/state`）的导出和 JSDoc 生成，`docs:verify` 查是否最新；不手写、不加 `@primitive` 标记。光有清单挡不住重复（`packages/testkit/README.md` 列了 `until`，仍被包了两层），要配一条认得出原样重复的 lint 一起做 |
| 流按任意切片测、`reduce` 的不变量 | 挡解析器假设「一次到一整行」、挡核心状态出现非法组合 | 同上，出现第一个这类问题时 |
| 常驻集合由谁删 | 服务端一直开着，只加不删的 `Map`、`Set` 会慢慢长大 | 逐处清点服务端非测试代码里的 `new Map(`（7 处）：键是什么、什么时候删；清点完再看值不值得写成 lint |
| 重复代码、布尔字段进体检的报告 | 抄了两份的逻辑改一处漏一处；几个布尔字段拼出来的状态可能是没写出来的联合 | 并进[体检](.agents/notes/proposed/process/2026-10-29-repo-health-readings.md)的读数表：jscpd 15 行以上的重复块、两个以上布尔字段的形状，只出报告 |
| `refactor/` 不许动契约、模块按接口重写 | 实现可以整个换掉，人只读接口和测试 | 契约稳定以后：回放里 28 个 `refactor/` PR 有 25 个改了契约，现在立这条会挡下大多数重构 |
| 骨架化、回归测试的 skill | 把判断固定下来 | 同一件事做到第二次、步骤还成立时，写成 `.agents/skills/` 下的 skill |

## Alternatives considered

**照搬白皮书的五层。** 目录（`src/contracts`、`src/features`）和工具（ast-grep、dependency-cruiser、bun）和这里的 `vp`、oxlint、按模块分的服务端冲突；一份通用的「宪章」进仓库，agent 分不清该照它还是照 `AGENTS.md`。原文不进仓库。

**以契约区为主线。** 主人只读契约、实现交给机器验、坏了按接口重写。前提是契约稳定；这里还不是，见上表的回放。

**行数上限、3+1 除草节律、命令防火墙、存档快照、合并队列、模型路由、人工盲降演练。** 和这里的规矩冲突（体检不设行数门槛，帮工没有权限确认，内部不留兼容），或者只有一位主人、PR 串行合并时用不上。

## Acceptance criteria

- 表里每一项做的时候各开一篇 Note 或并进它挂靠的那篇，做完从本篇删掉那一行；表空了删掉本篇。

## Risks

- **触发条件没人盯**：「出现第一个这类回归时」要有人想起本篇。修那个回归的 PR 由 [vv-pr](.agents/skills/vv-pr/SKILL.md) 补回归测试时，顺带看一眼本篇。
