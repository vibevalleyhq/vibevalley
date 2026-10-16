# Agent Note: 帮工是 oar 的子 agent，不要权限确认

Status: implemented

## Problem

帮工要是真实的编码 agent：能读写文件、跑命令、提交，能被插话、叫停，能报告每一轮的结果。不同的 runtime 有各自的协议、权限模型和会话参数。

## Decision

每个帮工是 oar 子 agent 的一个会话：当初用 oar 的 `createSubagents()`，现在是 smith（oar 的 Go 移植，`server/pkg/smith`）的 `agents`，在 `server/internal/runs/crew.go` 里（[服务端用 Go 重写](2026-10-13-go-server-on-smith.md)）；并发上限 6、深度上限 1。帮工档案的人设、技能、MCP 服务器和禁用的工具，通过一个只给这次派活用的 runtime 包装传进会话（oar 的 spawn 只收模型、思考强度、环境变量和目录）。会话事件变成核心状态的事实（[farm-core-state](2026-10-11-farm-core-state.md)），每轮的报告交给管家。

oar 默认不要权限确认、不开沙箱。2026-10-10 主人确认接受，用这几道边界代替：帮工只在 `VIBEVALLEY_WORK_ROOT` 下的项目里开工，每人一个 git worktree 和分支（[projects-worktrees-and-harvest](2026-10-10-projects-worktrees-and-harvest.md)）；服务端只听 127.0.0.1（后来有两个例外，都是另开的监听、各有钥匙：经隧道给声网的语音线路，见 [语音接到我们自己的管家](../feature/2026-10-10-voice-through-our-manager.md)；默认关着、只放主人点过头的设备的院门，见 [院门](../feature/2026-10-14-yard-gate.md)）。

## Alternatives considered

**每种 runtime 自己接。** oar 已经统一了发现、开会话、事件、插话和报告，自己接要重写这些。

**开着权限确认，由页面一个个批准。** 页面还没有批准的界面（「除草」，见 [permission-requests-as-weeds](../../proposed/feature/2026-10-10-permission-requests-as-weeds.md)）；在那之前开着确认，帮工会卡在第一个命令上。

**开沙箱。** 各 runtime 的沙箱能力不一样（codex 有 `OAR_CODEX_SANDBOX`，其他没有统一的），先用工作目录和 worktree 圈住。

## Consequences

一套代码驱动全部 runtime，帮工真能干活。代价是帮工能在这台机器上执行任意命令：服务端绝不能对外，接上「除草」之前这是已知的风险（[guide.md](../../../../docs/guide.md)「安全须知」）。VibeValley 按本机单人使用设计，没有登录。
