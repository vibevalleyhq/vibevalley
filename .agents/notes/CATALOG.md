# Agent Notes 目录

由 [scripts/docs/agent-notes.ts](scripts/docs/agent-notes.ts) 从每篇 Note 的路径和标题写成，不手改：加、挪、删 Note 或改了标题以后跑 `vp run notes:catalog`，过期了 `vp run notes:verify` 会报错。Note 放在哪、怎么写见 [README](.agents/notes/README.md)。

## proposed（25 篇）

### feature

- 2026-11-11 [用户和帮工的名字由人定](.agents/notes/proposed/feature/2026-11-11-names-people-set.md)
- 2026-11-11 [工单详情的经过合成一条活动流](.agents/notes/proposed/feature/2026-11-11-issue-activity-stream.md)
- 2026-11-10 [网页 Artifact 的 motion 动画时间轴与导出视频](.agents/notes/proposed/feature/2026-11-10-html-artifact-kinds.md)
- 2026-11-04 [网页 Artifact 的元素锚点、锚点评论与高度回报](.agents/notes/proposed/feature/2026-11-04-html-artifact-display.md)
- 2026-10-27 [通用 OpenAI Realtime 模型经本机 WebSocket 接电话与通话通道拆分](.agents/notes/proposed/feature/2026-10-27-realtime-calls-over-websocket.md)
- 2026-10-22 [记忆树：接真数据与手艺播种](.agents/notes/proposed/feature/2026-10-22-memory-tree.md)
- 2026-10-21 [助手给用户报告：早报、仓库健康度、工单之间的关系和分拣建议](.agents/notes/proposed/feature/2026-10-21-the-orchestrator-reports.md)
- 2026-10-20 [几个帮工同时写一篇文章：在屏幕上看起来怎样](.agents/notes/proposed/feature/2026-10-20-block-editor-ux.md)
- 2026-10-13 [帮工各自的音色](.agents/notes/proposed/feature/2026-10-13-helper-voices.md)
- 2026-10-10 [pi 打磨好之后接回其他 runtime](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)
- 2026-10-09 [商店和每日任务](.agents/notes/proposed/feature/2026-10-09-shop-and-daily-tasks.md)
- 2026-10-09 [手机竖屏版面](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)

### architecture

- 2026-11-12 [模块要深：合并把一件事拆散的模块，接口收窄到调用方要的](.agents/notes/proposed/architecture/2026-11-12-deep-modules.md)
- 2026-11-11 [扩展剩余跨模块品牌主键与 SQL 主外键自动品牌生成](.agents/notes/proposed/architecture/2026-11-11-type-driven-boundaries-and-branded-ids.md)
- 2026-11-10 [拆出 apps/machine：一个服务端经出站长连接管多台机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md)
- 2026-11-10 [邮箱收成一把锁、删掉回填地址的方法、页面不再深拷贝每一帧](.agents/notes/proposed/architecture/2026-11-10-atomic-commits-and-hot-paths.md)
- 2026-11-07 [让获授权的工作持续推进并可信交付](.agents/notes/proposed/architecture/2026-11-07-authorized-work-and-prompt-design.md)
- 2026-11-06 [Space 核心业务概念模型（Space、Repo、Worktree、Issue、Pkm 与执行体）](.agents/notes/proposed/architecture/2026-11-06-space-domain-model.md)
- 2026-10-28 [agent 带什么：工具集（toolsets）和技能（skill 模块），用户用 `/` 叫它们](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)
- 2026-10-18 [记忆表加上用户画像和干活的经过，相似的新记忆取代旧的](.agents/notes/proposed/architecture/2026-10-18-profile-and-episode-memories.md)
- 2026-10-18 [一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)

### process

- 2026-11-10 [用 AST 切片、模型判别与单向棘轮收敛三类存量工程债](.agents/notes/proposed/process/2026-11-10-ast-and-model-debt-convergence.md)
- 2026-10-30 [白皮书里还没做的：骨架、重复 lint、流切片、常驻集合和体检，各在什么时候做](.agents/notes/proposed/process/2026-10-30-whitepaper-checks-that-say-how.md)
- 2026-10-29 [给仓库做体检：跨区共改、模块深度与代码存活率读数](.agents/notes/proposed/process/2026-10-29-repo-health-readings.md)

### testing

- 2026-11-08 [等待器真实时间上限、模块窄替身与测试时钟门禁收窄](.agents/notes/proposed/testing/2026-11-08-testable-module-boundaries.md)
