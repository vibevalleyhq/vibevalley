# Agent Notes 目录

由 [scripts/agent-notes.ts](../../scripts/agent-notes.ts) 从每篇 Note 的路径和标题写成，不手改：加、挪、删 Note 或改了标题以后跑 `bun run notes:catalog`，过期了 `bun run notes:verify` 会报错。Note 放在哪、怎么写见 [README](README.md)。

## proposed（12 篇）

### feature

- 2026-10-13 [帮工各自的音色](proposed/feature/2026-10-13-helper-voices.md)
- 2026-10-10 [pi 打磨好之后接回其他 runtime](proposed/feature/2026-10-10-other-runtimes.md)
- 2026-10-09 [商店和每日任务](proposed/feature/2026-10-09-shop-and-daily-tasks.md)
- 2026-10-09 [手机竖屏版面](proposed/feature/2026-10-09-mobile-layout.md)
- 2026-10-09 [每个动作至少播完一小段](proposed/feature/2026-10-09-action-queue.md)

### architecture

- 2026-10-17 [Worker 改叫 Session](proposed/architecture/2026-10-17-worker-is-a-session.md)
- 2026-10-17 [Session、Run、事件：一个 agent loop 的日志，和消息之间只有两个口子](proposed/architecture/2026-10-17-session-run-step.md)
- 2026-10-17 [管家是一份内置档案](proposed/architecture/2026-10-17-manager-is-an-agent.md)
- 2026-10-17 [先有能力，再有入口：一张能力表，接口、命令行、管家、帮工都从它来](proposed/architecture/2026-10-17-capabilities-before-surfaces.md)
- 2026-10-16 [Run 是一次干活，Session 跨好几次 run，小队（Crew）编排 agent](proposed/architecture/2026-10-16-runs-sessions-crews.md)
- 2026-10-15 [概念先行，农场是皮](proposed/architecture/2026-10-15-concepts-first.md)
- 2026-10-14 [先采样，再验收：规划和运行分开，故障回流成样本](proposed/architecture/2026-10-14-sample-then-verify.md)

## implemented（84 篇）

### feature

- 2026-10-16 [仓库装收获了的工单](implemented/feature/2026-10-16-warehouse-is-harvested-issues.md)
- 2026-10-15 [地图：每个项目一座岛，地是它的 worktree 和空位](implemented/feature/2026-10-15-project-map.md)
- 2026-10-15 [农场盖满窗口，裁一点边](implemented/feature/2026-10-15-farm-fills-the-window.md)
- 2026-10-14 [院门：局域网里别的设备用同一个农场](implemented/feature/2026-10-14-yard-gate.md)
- 2026-10-14 [一次种植是一张工单](implemented/feature/2026-10-14-tickets.md)
- 2026-10-14 [手机上的通知](implemented/feature/2026-10-14-phone-notifications.md)
- 2026-10-13 [每个帮工和管家都有一条轨迹，帮工走了也留着](implemented/feature/2026-10-13-trajectories.md)
- 2026-10-13 [管家有自己的页面；记性按「手上的活、下回会想起、记下的」展示；语音设置分线路和管家两处](implemented/feature/2026-10-13-agent-pages-memory-and-voice.md)
- 2026-10-12 [声音页：Agora 和语音管家的设置在一页里改，只存改过的](implemented/feature/2026-10-12-voice-page.md)
- 2026-10-12 [首页和设置：开始、继续、设置；钥匙存在 settings.json](implemented/feature/2026-10-12-title-screen-and-settings.md)
- 2026-10-12 [开新地与 GitHub 串门](implemented/feature/2026-10-12-project-import.md)
- 2026-10-12 [手机里的仓库推箱子](implemented/feature/2026-10-12-phone-sokoban.md)
- 2026-10-12 [农场手机：要你处理的事当来电，从核心状态现算](implemented/feature/2026-10-12-farm-phone.md)
- 2026-10-12 [项目页：把代码库当一块地看](implemented/feature/2026-10-12-codebase-page.md)
- 2026-10-12 [图鉴：一页看全农场的素材](implemented/feature/2026-10-12-asset-browser.md)
- 2026-10-11 [种植计划：把长任务拆成一张图，交给不同的帮工](implemented/feature/2026-10-11-playbooks.md)
- 2026-10-11 [像素村：风来之国那样的画面](implemented/feature/2026-10-11-pixel-village.md)
- 2026-10-11 [农场群聊：主人、管家和帮工在同一个对话里](implemented/feature/2026-10-11-farm-group-chat.md)
- 2026-10-11 [接回 claude 和 codex](implemented/feature/2026-10-11-claude-and-codex.md)
- 2026-10-11 [在不同的频道里安排任务：多频道、外部渠道、定时任务](implemented/feature/2026-10-11-channels-and-schedules.md)
- 2026-10-11 [成就和金币：奖结果，记在服务端的账本里，看得到进度](implemented/feature/2026-10-11-achievements.md)
- 2026-10-10 [帮工沿着路走](implemented/feature/2026-10-10-walking-on-paths.md)
- 2026-10-10 [语音接到我们自己的管家](implemented/feature/2026-10-10-voice-through-our-manager.md)
- 2026-10-10 [语音用 Agora ConvoAI，照官方示例搬过来](implemented/feature/2026-10-10-voice-through-agora-quickstart.md)
- 2026-10-10 [音效在页面里合成，按响度分档](implemented/feature/2026-10-10-synthesized-sound-effects.md)
- 2026-10-10 [汇报取「结论」，失败说人话](implemented/feature/2026-10-10-report-conclusions-and-failures.md)
- 2026-10-10 [额度画成精力瓶，花费看得见，派活有上限](implemented/feature/2026-10-10-quota-spend-and-limits.md)
- 2026-10-10 [很久没动静的一轮要提醒](implemented/feature/2026-10-10-quiet-turns.md)
- 2026-10-10 [帮工的干活过程逐步记下来](implemented/feature/2026-10-10-helper-work-log.md)
- 2026-10-10 [农场经验就是你的 commit](implemented/feature/2026-10-10-experience-is-commits.md)
- 2026-10-09 [画成一座农场，不是工地](implemented/feature/2026-10-09-farm-instead-of-construction-site.md)

### simplification

- 2026-10-14 [网页退役：删掉网页，规则只留 Go 一份](implemented/simplification/2026-10-14-retire-the-web-page.md)
- 2026-10-14 [一个服务端、一个客户端：退役 TypeScript 服务端、Electron 和 MyGo，网页冻结](implemented/simplification/2026-10-14-one-server-one-client.md)
- 2026-10-12 [页面只给真实数据](implemented/simplification/2026-10-12-real-data-only.md)
- 2026-10-12 [只留像素村，拿掉手绘的旧版农场和它的图](implemented/simplification/2026-10-12-pixel-only.md)
- 2026-10-10 [先把 pi 打磨好，再逐个接回别的 runtime](implemented/simplification/2026-10-10-pi-only-for-now.md)
- 2026-10-09 [删掉工地版的代码，和别的停用代码](implemented/simplification/2026-10-09-delete-site-v0.md)

### architecture

- 2026-10-17 [迁移是一次性的，启动只认今天的名字](implemented/architecture/2026-10-17-one-way-migration.md)
- 2026-10-17 [表按模块命名](implemented/architecture/2026-10-17-names-by-module.md)
- 2026-10-17 [收敛接缝：投影一处、死代码进检查、协议瘦身、异步有规矩、客户端一个入口](implemented/architecture/2026-10-17-converge-the-seams.md)
- 2026-10-17 [接口带版本，都在 /api/v1 下](implemented/architecture/2026-10-17-api-versioned-paths.md)
- 2026-10-16 [客户端问服务端，不重写它的规则](implemented/architecture/2026-10-16-the-client-asks-the-server.md)
- 2026-10-16 [规则跟着它的主人，黄金数据跟着规则](implemented/architecture/2026-10-16-rules-live-with-their-owner.md)
- 2026-10-16 [一个包一个 Service](implemented/architecture/2026-10-16-one-service-per-package.md)
- 2026-10-16 [只有一份表结构，不认旧数据](implemented/architecture/2026-10-16-one-schema-no-old-data.md)
- 2026-10-16 [配置只有一份 YAML 和环境变量，由 viper 读](implemented/architecture/2026-10-16-one-config-file.md)
- 2026-10-16 [服务端的游戏收在一处](implemented/architecture/2026-10-16-game-in-one-place.md)
- 2026-10-16 [改完旧名字，主键用 uuidv7](implemented/architecture/2026-10-16-finish-the-renames.md)
- 2026-10-16 [按业务分深模块，包名用单数和自己的词](implemented/architecture/2026-10-16-deep-modules-singular-names.md)
- 2026-10-16 [通用的小封装收进 pkg/x](implemented/architecture/2026-10-16-common-wrappers-in-pkg-x.md)
- 2026-10-16 [客户端分层：两张皮在上，共用的在下](implemented/architecture/2026-10-16-client-layers.md)
- 2026-10-16 [定时是一张工单的触发，工单可以派给管家](implemented/architecture/2026-10-16-a-schedule-is-a-trigger.md)
- 2026-10-16 [一个概念一个包](implemented/architecture/2026-10-16-a-package-per-concept.md)
- 2026-10-15 [查询由 sqlc 生成](implemented/architecture/2026-10-15-sqlc-queries.md)
- 2026-10-15 [官网放在 site/，用游戏自己的图，会动的部分是 React](implemented/architecture/2026-10-15-site.md)
- 2026-10-15 [服务由 fx 组装](implemented/architecture/2026-10-15-services-assembled-by-fx.md)
- 2026-10-15 [服务端一个模块：internal 和 pkg，smith 并进来](implemented/architecture/2026-10-15-server-internal-and-pkg.md)
- 2026-10-15 [仓库就两块：server/ 和 app/](implemented/architecture/2026-10-15-server-and-app.md)
- 2026-10-15 [种植计划是带子工单的父工单](implemented/architecture/2026-10-15-plans-are-parent-issues.md)
- 2026-10-15 [工单进核心状态，有标题和说明](implemented/architecture/2026-10-15-issues-in-core-state.md)
- 2026-10-15 [工单是一样东西](implemented/architecture/2026-10-15-issue-is-one-thing.md)
- 2026-10-15 [要你处理的事是一个 Inbox](implemented/architecture/2026-10-15-inbox.md)
- 2026-10-15 [形状的源头是 Go：TypeScript 退出](implemented/architecture/2026-10-15-go-owns-the-shapes.md)
- 2026-10-13 [服务端用 Go 重写，帮工建在 smith 上](implemented/architecture/2026-10-13-go-server-on-smith.md)
- 2026-10-13 [客户端迁到 Flutter，完整复刻网页版](implemented/architecture/2026-10-13-flutter-client-over-ts-server.md)
- 2026-10-12 [自己的 agent：Go 写的，当管家，也当帮工](implemented/architecture/2026-10-12-own-agent.md)
- 2026-10-12 [像素村的像素密一倍](implemented/architecture/2026-10-12-denser-pixels.md)
- 2026-10-11 [帮工的规则写成纯函数，会话只管生命周期](implemented/architecture/2026-10-11-session-rules-as-pure-functions.md)
- 2026-10-11 [农场是一份核心状态，只因事实而变](implemented/architecture/2026-10-11-farm-core-state.md)
- 2026-10-11 [每个 agent 的记性：一轮开始时想起，结束时记下，存法可以换](implemented/architecture/2026-10-11-agent-memory.md)
- 2026-10-10 [工地事件走 server-sent events，命令走 HTTP](implemented/architecture/2026-10-10-site-events-over-sse.md)
- 2026-10-10 [服务端重启不丢农场](implemented/architecture/2026-10-10-restart-keeps-the-farm.md)
- 2026-10-10 [项目、每人一个 worktree，收获前先查冲突](implemented/architecture/2026-10-10-projects-worktrees-and-harvest.md)
- 2026-10-10 [帮工是 oar 的子 agent，不要权限确认](implemented/architecture/2026-10-10-helpers-as-oar-subagents.md)

### process

- 2026-10-17 [文档里写的路径也查](implemented/process/2026-10-17-paths-in-docs-are-checked.md)
- 2026-10-17 [写作规范以信息密度为主，STE 只留词和格式](implemented/process/2026-10-17-one-writing-standard.md)
- 2026-10-17 [让容易的写法就是对的写法](implemented/process/2026-10-17-make-the-easy-thing-the-right-thing.md)
- 2026-10-15 [改名 VibeValley（码农场物语）](implemented/process/2026-10-15-rename-to-vibevalley.md)
- 2026-10-15 [Note 的目录由脚本生成，检查跑在 Bun 上](implemented/process/2026-10-15-notes-catalog.md)
- 2026-10-12 [桌面客户端分 alpha、beta、release 三个渠道打包](implemented/process/2026-10-12-release-channels.md)
- 2026-10-11 [决策记在 Agent Notes，文档只写现状](implemented/process/2026-10-11-agent-notes-and-doc-tiers.md)
- 2026-10-09 [素材用 codex 生图，脚本切图](implemented/process/2026-10-09-image-pipeline-with-codex.md)

### testing

- 2026-10-17 [测试共用一套工具和一个替身](implemented/testing/2026-10-17-one-test-kit.md)
- 2026-10-10 [服务端测试用脚本扮演帮工](implemented/testing/2026-10-10-scripted-runtime-server-tests.md)

## rejected（2 篇）

### feature

- 2026-10-10 [帮工的权限请求变成地里的杂草](rejected/feature/2026-10-10-permission-requests-as-weeds.md) — 帮工不做权限确认是常驻规矩：靠本机、工作目录和院门划边界，逐条批准会让帮工停在命令上等人，和无人值守冲突；「除草」留着位置

### architecture

- 2026-10-11 [游戏层往哪走：全用 TS，在 Pixi 上自己写引擎；Rust 等真要原生宿主时再进来](rejected/architecture/2026-10-11-game-engine-direction.md) — 客户端换成了 Flutter，像素村用 Flame 画，没有走 TS 加 Pixi 自己写引擎；对 Rust、Bevy 和 Agora 绑定的评估仍然有用
