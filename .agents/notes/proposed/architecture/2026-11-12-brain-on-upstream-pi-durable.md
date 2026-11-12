# Agent Note: 大脑换回上游的 pi-durable

Status: proposed

## Problem

2026-10-27 为了让大脑整个跑在 Effect 里，把 pi-ai 和 pi-agent-core 重写成了 `packages/ai`、`packages/agent`，又在 `mailbox`、`session` 里自己做持久和恢复。2026-11-12 仓库拿掉了 Effect（[地基](docs/subsystems/foundation.md#为什么这样)），这两个包随之照退路改成了普通 TypeScript，原样保留了重写的循环。

留下的问题是重写本身：上游的 `@earendil-works/pi-durable`（输入、每一轮、工具调用先落盘再显示，进程死掉后从断点接着跑）在 2026-10-01 已经出到 1.0，oar 0.86 把它包成了现成的 runtime（`createPiDurableRuntime`）。我们自己的两个 runtime（助手的 `session/host.ts`、农机 `runtime/vibevalley.ts`）至今写着 `queue: { durable: false }`：服务端在助手回答到一半时停掉，重启后这一轮不会接着答，只靠 [talk.test.ts](apps/server/src/flows/talk.test.ts) 守着的「重启后回到同一个对话」。

## Proposal

1. **先验证。** `createPiDurableRuntime` 接进 runtime 注册表（`apps/server/src/modules/runtime`），只给助手用；写一个流程测试：说一句话、在模型回答到一半时关掉农场（`farm.close()`）、用同一个家目录和库再起一个、它接着答完，且这一轮只记一次。
2. **通过就换。** 删掉 `packages/agent`、`packages/ai` 里重写的循环和持久（`brain/session.ts` 的 `.jsonl`、压缩、前缀校验），以及 `session`、`mailbox` 里只为它做的恢复；会话之间的事（谁被触发、派给谁、排队）仍归 `mailbox`。工具、技能、记性、MCP 经 pi 的扩展接口挂上去；DeepSeek 的专有适配器（[大脑](docs/subsystems/brain.md#模型边界)）照旧在 `packages/provider`。
3. **不通过就停在现在。** 现在的普通 TypeScript 循环就是退路，不再改它的结构。

## Alternatives considered

- **留着自己的循环，补上持久。** 在 `packages/agent` 里照 pi-durable 的做法先落盘再显示。没选作首选：那是把上游现成的再写一遍，以后上游的新能力（并行工具、新的压缩）还要再追。
- **只给帮工的农机用 pi-durable，助手不动。** 没选：断点续答对助手最有用（用户在等它回话），帮工的一轮由 `mailbox` 交回和重派兜着。

## Acceptance criteria

- 上面第 1 步的流程测试在；助手的评测（[vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 的助手评测分册，花钱，先问用户）不比换之前差。
- `packages/agent`、`packages/ai` 里不再有自己的循环和持久；`docs/subsystems/brain.md` 改成新的样子，删掉本 Note。

## Risks

- **pi-durable 还在变。** 它自己标着 Experimental。缓解：只经 oar 的 runtime 接口用它，版本钉死在 catalog，升级走验收。
- **提示前缀和压缩的行为变了，助手答得不一样。** 缓解：换之前和换之后各跑一遍助手的评测，对比表放进 PR。
