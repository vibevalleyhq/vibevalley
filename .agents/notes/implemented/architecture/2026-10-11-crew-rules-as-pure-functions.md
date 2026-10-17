# Agent Note: 帮工的规则写成纯函数，crew.ts 只管会话

Status: implemented

## Problem

TypeScript 服务端的 `crew.ts` 长到 800 多行：开会话、关会话、重启后接回这些要碰 oar 和文件的事，和「一个会话事件意味着什么」「一份汇报怎么读」「还能不能再派一个」这些规则写在一起。规则读着核心状态、改着会话的记账、直接施加事实，要测只能起一个脚本扮演的会话，等事件真的流过来；一个算错的花费或一个没去掉的「没动静」，要绕一整轮派活才看得到。

## Decision

规则拆成四个纯函数模块，不碰会话、文件、时钟和 Effect 的服务（当时是 TypeScript 服务端的四个文件；Go 服务端照搬了这个分法：`crewSessionFacts`（记账是 `crewTracking`，步骤是 `crewOp`）在 `server/internal/session/facts.go`，读汇报（`crewReadReport`）、上限（`crewNoRoom`）、帮工的说明在 `internal/session/rules.go`，`session/sessions.go` 只管会话的生命周期；收获、合并后来又从它挪到了 `tickets` 的 `Merges`，见 [概念先行](../../proposed/architecture/2026-10-15-concepts-first.md) 的第 3 步）：

- `session-facts.ts`：`sessionFacts(event, helper, tracking, ctx)`。一个 oar 事件、帮工在核心状态里的样子、这个会话自己的记账（`Tracking`：气泡显示的那次工具调用、会话的 token 累计、模型价格、这一轮开始时花了多少、是不是被标了没动静）进去；要施加的事实、干活过程要记的步骤（`JournalOp`，`steps.ts` 的 `record` 照着记）、新的记账、这次花了多少人民币、要查价的模型、要说的提醒出来。
- `report.ts`：`readReport(report)`，一份汇报的结局、留下的原话、结论、失败原因、要不要你处理。
- `briefing.ts`：人设和技能、农场的规矩、会话选项。
- `limits.ts`：`noRoom(helpers, runtime, project, limits)` 和帮工的名字。

`crew.ts` 留下会话的生命周期：开、接上事件、标没动静、关、收获、重启后接回。它收到一个事件，就调 `sessionFacts`，把结果原样做掉：记步骤、施加事实、记花费、查价、发提醒。

## Alternatives considered

**按功能拆成几个 Effect 服务**（花费一个、干活过程一个……）。它们都要读同一个帮工、同一份会话记账，拆成服务要么互相依赖，要么各存一份；规则也还是要起 Layer 才能测。纯函数只要一个值进、一个值出。

**`sessionFacts` 返回之前，自己把事实折进帮工里再往下判断**（用 `reduce`）。一个事件最多产生「解除没动静」加一条事实，前一条不改后一条要看的字段，所以直接对照传进来的帮工就够了，不用在规则里再跑一遍 `reduce`。

**保持一个文件，只加测试。** 测试还得经过真的会话；文件也还是两种东西混在一起，下一次加规则还会长。

## Consequences

`crew.ts` 从 826 行减到 555 行，规则有了不开会话的单元测试（当时的 `session-facts.test.ts`、`report.test.ts`、`limits.test.ts`，现在是 `server/internal/session/rules_test.go`），一个事件一个断言。代价是多了一层间接：`crew.ts` 要把结果「照做」，步骤先变成数据再记；会话的记账从 `Hand` 的几个字段收成一个 `Tracking`，每次事件换一个新值。查价是异步的，结果回来时并进当时的 `Tracking`，不用事件那一刻的。
