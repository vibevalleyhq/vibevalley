# Agent Note: 服务端重启不丢农场

Status: implemented

## Problem

服务端会重启（改代码、机器重启）。一开始状态都在内存里：重启后帮工没了，worktree 和分支还在磁盘上没人管，管家也忘了刚才说过什么。

## Decision

- 核心状态存在 `$VIBEVALLEY_HOME/farm.json`（写入合并 0.5 秒，先写临时文件再改名；田头、进度、定时和工单除外，它们的家是数据库 `farm.db`，开机放回核心状态）；管家的会话在 `foreman/`；每个帮工的会话 id、worktree 目录、最后一轮原话和这个会话已经想起过的记性在 `crew.json`（接回原会话时不再提一遍；接不上、另开新会话时重新想起）；干活过程在 `steps/`。
- 重启后帮工回到各自的地上，会话先不打开。有人带话时，smith（oar 的 Go 移植）按会话 id 接着原来的会话开新一轮；接不上就在同一个 worktree 里新开会话，并告诉它看 git log。收获、收工不需要会话。
- 重启时正在干的那一轮记成「VibeValley 重启了，这一轮停在了半路」，帮工歇着，发一条提醒；worktree 不见了的不接回来。
- 帮工编号接着以前的往下排，不会撞上旧的干活过程。

## Alternatives considered

**重启时把帮工全部收工。** 简单，但没合的活和它的上下文都丢了，主人还得重派。

**重启时自动接着干。** 帮工可能正跑到一半，自动重来会重复执行命令、重复花钱；交给主人一句话决定。

## Consequences

重启对主人几乎透明，花一句话就能接着干。代价是要维护两个持久化文件和它们之间的对应（`farm.json` 里有、`crew.json` 里没有的帮工会被请走）。

## Verification

`server/internal/farm/crew_test.go` 的 `TestCrewRestartHelpersComeBackResting`：第一次运行雇一个帮工并提交，第二次运行它在地里、带话能接着干、能收获。
