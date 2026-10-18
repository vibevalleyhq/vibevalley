# Agent Notes 目录

由 [scripts/agent-notes.ts](scripts/agent-notes.ts) 从每篇 Note 的路径和标题写成，不手改：加、挪、删 Note 或改了标题以后跑 `bun run notes:catalog`，过期了 `bun run notes:verify` 会报错。Note 放在哪、怎么写见 [README](.agents/notes/README.md)。

## proposed（15 篇）

### feature

- 2026-10-13 [帮工各自的音色](.agents/notes/proposed/feature/2026-10-13-helper-voices.md)
- 2026-10-10 [pi 打磨好之后接回其他 runtime](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)
- 2026-10-09 [商店和每日任务](.agents/notes/proposed/feature/2026-10-09-shop-and-daily-tasks.md)
- 2026-10-09 [手机竖屏版面](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)
- 2026-10-09 [每个动作至少播完一小段](.agents/notes/proposed/feature/2026-10-09-action-queue.md)

### architecture

- 2026-10-18 [Task：一张按 DAG 推进的活，agent 自己的步骤和种植计划都是它](.agents/notes/proposed/architecture/2026-10-18-tasks-are-dags.md)
- 2026-10-18 [种子数据由服务端给，客户端不带副本](.agents/notes/proposed/architecture/2026-10-18-seeds-come-from-the-server.md)
- 2026-10-18 [编排层：每个 agent 一个信箱，什么时候交给它只在一处定](.agents/notes/proposed/architecture/2026-10-18-one-mailbox-per-agent.md)
- 2026-10-18 [记忆都存在 SQLite：照 Hermes 分四类，一张表、一张全文索引，主人画像、管家的记性和干活的经过都进来](.agents/notes/proposed/architecture/2026-10-18-memory-in-sqlite.md)
- 2026-10-18 [一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)
- 2026-10-17 [Session、Run、事件：一个 agent loop 的日志，和消息之间只有两个口子](.agents/notes/proposed/architecture/2026-10-17-session-run-step.md)
- 2026-10-17 [管家是一份档案，只是能力多](.agents/notes/proposed/architecture/2026-10-17-manager-is-an-agent.md)
- 2026-10-15 [概念先行，农场是皮](.agents/notes/proposed/architecture/2026-10-15-concepts-first.md)
- 2026-10-14 [先采样，再验收：规划和运行分开，故障回流成样本](.agents/notes/proposed/architecture/2026-10-14-sample-then-verify.md)

### process

- 2026-10-18 [用 VibeValley 开发 VibeValley](.agents/notes/proposed/process/2026-10-18-build-vibevalley-with-vibevalley.md)

## rejected（2 篇）

### feature

- 2026-10-10 [帮工的权限请求变成地里的杂草](.agents/notes/rejected/feature/2026-10-10-permission-requests-as-weeds.md) — 帮工不做权限确认是常驻规矩：靠本机、工作目录和「连接到本机」划边界，逐条批准会让帮工停在命令上等人，和无人值守冲突；「除草」留着位置

### architecture

- 2026-10-11 [游戏层往哪走：全用 TS，在 Pixi 上自己写引擎；Rust 等真要原生宿主时再进来](.agents/notes/rejected/architecture/2026-10-11-game-engine-direction.md) — 客户端换成了 Flutter，像素村用 Flame 画，没有走 TS 加 Pixi 自己写引擎；对 Rust、Bevy 和 Agora 绑定的评估仍然有用
