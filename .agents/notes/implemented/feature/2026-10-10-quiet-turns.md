# Agent Note: 很久没动静的一轮要提醒

Status: implemented

## Problem

帮工可能卡住：模型请求挂住、命令等输入、陷在循环里。它一直占着一块地、可能一直花钱，农场上却看起来在干活。

## Decision

- 每隔一会儿（阈值的四分之一，最多 15 秒）看一次会话的状态（smith 的 `observe.StallOf`，`server/internal/runs/crew.go` 的 `watchStalls`）；一轮里超过 `VIBEVALLEY_STALL_SECONDS`（默认 240 秒）没有任何记录，就施加 `quiet` 事实：地块干裂、挂「没动静」，农场上提醒一次，记进干活过程，管家的「农场现状」里也会说。它一有动静（下一个 `doing` 事实）就结束。
- 不自动叫停：可能只是在跑很久的命令，由主人决定。
- runtime 自己重试模型调用时施加 `retry` 事实，地块挂「重试中」。

## Alternatives considered

### Why not oar 的 observeStalls?

它只在订阅以后收到新记录才开始计时。帮工一开工就卡住时，订阅时这一轮已经开始，之后再没有记录，永远不会提醒。轮询状态没有这个漏洞。

**超时自动叫停。** 编译、装依赖、跑整套测试可能很久，自动叫停会打断正常的活。

## Consequences

卡住的帮工会被看见，决定权在主人。代价是每个会话一个定时器；阈值是一个全局值，不分命令。

## Verification

`server/internal/farm/crew_test.go` 的 `TestCrewQuietHelperIsFlagged`（测试里把阈值设得很短）；`server/internal/runs/rules_test.go` 的 `TestCrewQuietEndsWithAWordNotWithUsage`。
