# Agent Note: 帮工的干活过程逐步记下来

Status: implemented

## Problem

地块上只有一个气泡：此刻在做什么。帮工做完了、做砸了、卡住了，主人想知道它到底跑了什么命令、命令输出了什么、说了什么，只能去翻 oar 的原始日志。

## Decision

每个帮工的每一步记成一条 `Activity`（当时叫 `WorkStep`）（`server/internal/session/events.go`）：接到的工单和带话、说的话、每次工具调用（输入、输出、成没成）、重试、问题。

- 存在 `$VIBEVALLEY_HOME/activities/<id>.json`，留最近 240 步，帮工走了就删（后来改成走了也留着，过了 `trajectory.days` 天才删，见 [轨迹](2026-10-13-trajectories.md)）；工具输出保留开头和结尾（测试的结论在最后）。
- 地块详情打开时 `GET /api/workers/:id/activities` 拿全部，之后靠 `activity` 工地事件更新；还在长的一步（字还在出、工具还没返回）用同一个编号再发，发送合并到 0.3 秒一次。
- 干活过程不进核心状态：它大、长得快，只有打开详情时才需要（[farm-core-state](../architecture/2026-10-11-farm-core-state.md)）。

界面见 [farm-ui.md](../../../../docs/reference/farm-ui.md) 界面 2。

## Alternatives considered

**读 oar 写的会话原始记录（`logs/`）。** 是各家 runtime 自己的格式，要逐个解析；重启后会话没打开时读不到当前的那份。

**放进核心状态。** 每个工具调用都会让整份状态变大、频繁写盘，快照也跟着变大。

## Consequences

主人在页面里就能看清每一步，判断要不要叫停、带话还是收获。代价是多一份持久化和一种工地事件。
