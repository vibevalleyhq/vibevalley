# Agent Notes 目录

由 [scripts/agent-notes.ts](scripts/agent-notes.ts) 从每篇 Note 的路径和标题写成，不手改：加、挪、删 Note 或改了标题以后跑 `vp run notes:catalog`，过期了 `vp run notes:verify` 会报错。Note 放在哪、怎么写见 [README](.agents/notes/README.md)。

## proposed（20 篇）

### feature

- 2026-11-04 [网页稿子的元素锚点、锚点评论与高度回报](.agents/notes/proposed/feature/2026-11-04-html-artifact-display.md)
- 2026-10-27 [自己的实时模型经本机 WebSocket 接电话，其余照旧走声网](.agents/notes/proposed/feature/2026-10-27-realtime-calls-over-websocket.md)
- 2026-10-22 [记忆树：接真数据与手艺播种](.agents/notes/proposed/feature/2026-10-22-memory-tree.md)
- 2026-10-21 [管家给主人报告：早报、项目健康度、工单之间的关系和分拣建议](.agents/notes/proposed/feature/2026-10-21-the-orchestrator-reports.md)
- 2026-10-21 [管家的授权：按动作分档，跨轮的同意记下来](.agents/notes/proposed/feature/2026-10-21-orchestrator-authorization.md)
- 2026-10-20 [几个帮工同时写一篇文章：在屏幕上看起来怎样](.agents/notes/proposed/feature/2026-10-20-block-editor-ux.md)
- 2026-10-13 [帮工各自的音色](.agents/notes/proposed/feature/2026-10-13-helper-voices.md)
- 2026-10-10 [pi 打磨好之后接回其他 runtime](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)
- 2026-10-09 [商店和每日任务](.agents/notes/proposed/feature/2026-10-09-shop-and-daily-tasks.md)
- 2026-10-09 [手机竖屏版面](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)

### architecture

- 2026-10-28 [agent 带什么：工具集（toolsets）和技能（skill 模块），主人用 `/` 叫它们](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)
- 2026-10-27 [页面的连接接着带上在线状态和工单的增量](.agents/notes/proposed/architecture/2026-10-27-presence-and-entity-deltas.md)
- 2026-10-22 [状态先提交，副作用由 worker 在提交之后做](.agents/notes/proposed/architecture/2026-10-22-commit-then-effects.md)
- 2026-10-18 [记忆都存在农场的库里：主人画像和干活的经过进 memory 表](.agents/notes/proposed/architecture/2026-10-18-memory-in-sqlite.md)
- 2026-10-18 [一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)
- 2026-10-14 [先采样，再验收：规划和运行分开，故障回流成样本](.agents/notes/proposed/architecture/2026-10-14-sample-then-verify.md)

### process

- 2026-10-30 [白皮书里还没做的：骨架、重复 lint、流切片、常驻集合和体检，各在什么时候做](.agents/notes/proposed/process/2026-10-30-whitepaper-checks-that-say-how.md)
- 2026-10-29 [给仓库做体检：跨区共改、模块深度与代码存活率读数](.agents/notes/proposed/process/2026-10-29-repo-health-readings.md)
- 2026-10-25 [PR Review：日常评审看证据，同题比较再评分](.agents/notes/proposed/process/2026-10-25-pr-review-scoring.md)

### testing

- 2026-10-26 [把模块层往下压：项目检查成端口，项目的决定成规则](.agents/notes/proposed/testing/2026-10-26-press-the-module-layer-down.md)
