# Agent Notes 目录

由 [scripts/agent-notes.ts](scripts/agent-notes.ts) 从每篇 Note 的路径和标题写成，不手改：加、挪、删 Note 或改了标题以后跑 `vp run notes:catalog`，过期了 `vp run notes:verify` 会报错。Note 放在哪、怎么写见 [README](.agents/notes/README.md)。

## proposed（27 篇）

### feature

- 2026-10-22 [记忆树：让主人看见农场在长](.agents/notes/proposed/feature/2026-10-22-memory-tree.md)
- 2026-10-21 [管家给主人报告：早报、项目健康度、工单之间的关系和分拣建议](.agents/notes/proposed/feature/2026-10-21-the-orchestrator-reports.md)
- 2026-10-21 [管家的授权：按动作分档，跨轮的同意记下来](.agents/notes/proposed/feature/2026-10-21-orchestrator-authorization.md)
- 2026-10-20 [几个帮工同时写一篇文章：在屏幕上看起来怎样](.agents/notes/proposed/feature/2026-10-20-block-editor-ux.md)
- 2026-10-20 [块编辑器协同：按块存，按 op 改，服务端是唯一权威](.agents/notes/proposed/feature/2026-10-20-block-editor-collab.md)
- 2026-10-13 [帮工各自的音色](.agents/notes/proposed/feature/2026-10-13-helper-voices.md)
- 2026-10-10 [pi 打磨好之后接回其他 runtime](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)
- 2026-10-09 [商店和每日任务](.agents/notes/proposed/feature/2026-10-09-shop-and-daily-tasks.md)
- 2026-10-09 [手机竖屏版面](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)
- 2026-10-09 [每个动作至少播完一小段](.agents/notes/proposed/feature/2026-10-09-action-queue.md)

### architecture

- 2026-10-31 [频道只记话，信箱把话交给 agent：从 `Channel` 拆出 `Mailbox`，去掉 `useHelpers`](.agents/notes/proposed/architecture/2026-10-31-mailbox-out-of-channels.md)
- 2026-10-31 [页面的中间层建在 Effect Atom 上](.agents/notes/proposed/architecture/2026-10-31-client-state-on-atom.md)
- 2026-10-28 [agent 带什么：工具集（toolsets）和技能（skill 模块），主人用 `/` 叫它们](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)
- 2026-10-27 [页面的连接接着带上在线状态和工单的增量](.agents/notes/proposed/architecture/2026-10-27-presence-and-entity-deltas.md)
- 2026-10-22 [状态先提交，副作用由 worker 在提交之后做](.agents/notes/proposed/architecture/2026-10-22-commit-then-effects.md)
- 2026-10-22 [收回派活、工作区、配置、日志与手机线路的使用约束](.agents/notes/proposed/architecture/2026-10-22-close-ownership-gaps.md)
- 2026-10-18 [Task：一张按 DAG 推进的活，agent 自己的步骤和种植计划都是它](.agents/notes/proposed/architecture/2026-10-18-tasks-are-dags.md)
- 2026-10-18 [编排层：每个 agent 一个信箱，什么时候交给它只在一处定](.agents/notes/proposed/architecture/2026-10-18-one-mailbox-per-agent.md)
- 2026-10-18 [记忆都存在农场的库里：主人画像、管家的记性和干活的经过都进 memory 表](.agents/notes/proposed/architecture/2026-10-18-memory-in-sqlite.md)
- 2026-10-18 [一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)
- 2026-10-17 [Session、Run、事件：一个 agent loop 的日志，和消息之间只有两个口子](.agents/notes/proposed/architecture/2026-10-17-session-run-step.md)
- 2026-10-15 [概念先行，农场是皮](.agents/notes/proposed/architecture/2026-10-15-concepts-first.md)
- 2026-10-14 [先采样，再验收：规划和运行分开，故障回流成样本](.agents/notes/proposed/architecture/2026-10-14-sample-then-verify.md)

### process

- 2026-10-30 [白皮书里还没做的：扩展点只填空、共用帮手的清单、契约的 diff、I/O 次数，各在什么时候做](.agents/notes/proposed/process/2026-10-30-whitepaper-checks-that-say-how.md)
- 2026-10-29 [给仓库做体检：读数指出先看哪里，只有类型逃生口是棘轮](.agents/notes/proposed/process/2026-10-29-repo-health-readings.md)
- 2026-10-18 [用 VibeValley 开发 VibeValley](.agents/notes/proposed/process/2026-10-18-build-vibevalley-with-vibevalley.md)

### testing

- 2026-10-26 [把模块层往下压：项目检查成端口，重启留在内存，项目的决定成规则](.agents/notes/proposed/testing/2026-10-26-press-the-module-layer-down.md)

## rejected（1 篇）

### feature

- 2026-10-10 [帮工的权限请求变成地里的杂草](.agents/notes/rejected/feature/2026-10-10-permission-requests-as-weeds.md) — 帮工不做权限确认是常驻规矩：靠本机、工作目录和「连接到本机」划边界，逐条批准会让帮工停在命令上等人，和无人值守冲突；「除草」留着位置
