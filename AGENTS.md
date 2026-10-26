# AGENTS.md

VibeValley 是 AI 版的 Linear，一个在本机管编码 agent 的工作台，和 Multica 是一类东西：工单派给 agent 档案，服务端为它开一次执行（经 [oar](https://www.npmjs.com/package/@botiverse/oar) 驱动本机的编码 agent），在 `VIBEVALLEY_WORK_ROOT` 下，按档案设置在项目目录或工单的 worktree 里一轮一轮干活，主人看改动、合进主分支；主人、管家（替主人派活的 agent）和执行在群聊里说话。外面画成一座农场：项目是岛，在做的工单是一块地，执行是在地上干活的帮工，群聊是田头（[概念](docs/concepts.md)）。整个仓库是 TypeScript：服务端 `apps/server`（Effect）、页面 `apps/web`（Solid 2）、桌面壳 `apps/desktop`（Electron），和官网 `site/`（Astro）；服务端和页面之间的契约（形状、接口、两边都跑的少数规则）在 `packages/protocol`。改 `apps/`、`packages/` 之前读 [docs/architecture.md](docs/architecture.md)；写文档照 [docs/AGENTS.md](docs/AGENTS.md) 和 [docs/style/writing.md](docs/style/writing.md)；子系统沉淀在 [docs/subsystems](docs/subsystems/README.md)，计划写成 [Agent Notes](.agents/notes/README.md)。

## 目录

```
apps/server/               服务端（Effect v4，Node 24 上用 tsx 跑）：src/ 里一块业务一个文件夹，名字用单数，每个导出一个服务
                           （Context.Service）：core、setting、agent、project、memory、doc、runtime、session、channel、recurrence、issue、
                           task、notice、tool、mcp、orchestrator、lan、voice、connector、game；projection 是核心状态的折法和拼帧（读各模块的
                           规则，组装时交给 core）；agent/brain 是 VibeValley 自己的 agent（搭在
                           pi-agent-core 上，也是 oar 的 vibevalley runtime）；base 是地基，services.ts 按次序把它们组装起来，
                           handlers.ts 是全部接口的处理，http/ 是路由、流和 /mcp；cli.ts 是命令行（农场的每个接口、和农机直接聊、
                           自己的 agent）
apps/server/db/            库（PGlite）：migrations/0001_schema.up.sql 是唯一的表结构，queries/<表>.sql 一张表一个文件，
                           generated/ 是 effect-sqlc 从它们写出的
apps/server/src/*/testdata 规则的黄金数据（*.jsonl.gz）和样例
apps/web/                  页面（Solid 2 + Vite）：桌面、浏览器、手机三个宿主共用的一份，由服务端（--web）在 / 提供；/ 是像素农场
                           （src/farm，PixiJS），其余是工作台（src/pages/<地方>）；public/ 是全部的图、像素字、指针和样音（apps/web/README.md）
apps/desktop/              Electron 壳：用自己的 Node 带着服务端起来，打开它提供的页面；宿主能力经 preload 给页面
apps/mobile/               手机壳（Expo、React Native）：扫码配对，WebView 打开那台电脑「连接到本机」放出的页面；通知、锁屏不断的通话经桥给页面
packages/protocol/         契约：形状（src/shapes.ts）、它们的 Schema（schema.ts）、接口（api.ts）和两边都跑的规则（src/rules）：服务端和页面
                           都用；只有服务端跑的规则在 apps/server/src 各自的模块里
packages/host/             宿主接口：页面能向宿主要的东西（通知、托盘、全局快捷键、通话的线路），和手机壳的桥
packages/engine/           像素农场的引擎：Pixi 的舞台、寻路、音效合成、日钟
site/                      官网 vibevalley.dev（Astro 静态生成，Tailwind，会动的部分是 React island）：图和像素字直接用 apps/web/public 的
design/                    生图提示词、脚本和切图规则（写进 apps/web/public）；原图和效果图在单独的仓库 vibevalley-art，design/art.sh 链接进来
docs/                      当前的行为和约定；subsystems/ 是各子系统从架构角度沉淀下来的样子（docs/AGENTS.md）
.agents/notes/             Agent Notes：具体的计划，做完沉淀进 docs/subsystems
.agents/skills/            项目自己的 skill：验收（acceptance，入口加按块的分册）等；.claude/skills 链接到这里
scripts/                   文档、Note、旧名字的检查，和验证服务端用的沙箱（verify-server.ts）
```

每个包的约定在它的 README。

## 命令

```bash
vp install                                                      # 根目录：装 apps/*、packages/* 的依赖（Vite+ 经 Bun workspaces）
bun run check                                                   # 改完任何代码：vp check，格式（oxfmt）、lint（oxlint，带类型）、类型；check:fix 改格式
cd apps/server && npm start                                     # 服务端，127.0.0.1:8787；-- --web ../web/dist 同时提供页面
cd apps/server && npm run cli -- issue list                     # 命令行：调农场的接口（help 列出全部），runtime chat <农机> 直接聊
bun run server:check                                            # 改完服务端或 packages/protocol：规则的测试、类型、查询是否最新、vitest
cd apps/server && bun run db:generate                           # 改完 db/queries 或 db/migrations：用 effect-sqlc 重写 db/generated
bun run golden:update                                           # 有意改了规则：用现在的结果重写各处的黄金数据，再看 diff（-- <模块> 只重写那一处，核心状态的是 core）
cd apps/server && npm run evals                                 # 改了管家的提示或工具描述：真模型重放管家的样例（要 DEEPSEEK_API_KEY、花钱，先问主人；acceptance 的管家评测分册）
bun run web:check                                               # 改完 apps/、packages/：各包的类型（手机壳也在内）、宿主的桥和手机壳的规则、页面能构建
cd apps/web && bun run test                                     # 改完页面：规则的 vitest，加 Playwright 对着真的服务端（每个 worker 一个，临时家目录，环境里没有钥匙）
cd apps/web && bun run test:dev                                 # 改了页面的响应式写法：Playwright 跑在 Solid 的开发版上，它的诊断（没被追踪的读、不该建的原语、追踪几千个源）连调用栈打出来
bun run desktop:test                                            # 改完 apps/desktop 或页面：Playwright 起整个 Electron 应用（临时家目录），附截图
bun run desktop:dev                                             # 桌面版：构建壳和页面，带着 apps/server 起来；改页面窗口自己刷新，改服务端或 protocol 服务端自己重启
cd apps/mobile && bun run check && bun run test                 # 改完手机壳；建原生工程、跑模拟器上的端到端见 apps/mobile/README.md
bun run package:mac                                             # macOS 应用和 .dmg（apps/desktop/dist）：壳、页面和带着生产依赖的 apps/server
bun run capabilities                                            # 改了 api.ts 的接口或 can：重写 docs/reference/capabilities.md（docs:verify 查它）
bun run api:client                                              # 改了 api.ts 的接口：重写 packages/protocol/src/client.ts 的 VibeValleyApi（docs:verify 查它）
bun run notes:catalog                                           # 加、挪、删 Note 或改了标题：重写 .agents/notes/CATALOG.md
bun run docs:verify                                             # 改完文档、Note 或 skill：Note 和 skill 的格式、目录是否最新、链接、旧名字
bun run site:check && bun run site:build                        # 改完 site/：类型和模板，再生成到 site/dist（不开 astro dev）
```

Node 24（服务端经 tsx 跑，脚本经 `vpx` 直接跑 `.ts`），Bun 1.4（workspaces、页面和 protocol 的单元测试），Electron 44。先跑和改动有关的最窄的检查。服务端不自动重载：改了 `apps/server` 要重启它。

一件事的主线：oar 的会话事件 → `apps/server/src/session/facts.ts`（纯函数）读成事实 → `Core.apply` 用 `projection/reduce.ts` 的 `reduce` 折进核心状态 → `GET /api/v1/state` 把折好的 `StateFrame` 经 SSE 推给页面；每个会话和管家的每一步由 `session/journal.ts` 记成轨迹（[architecture.md](docs/architecture.md)、[子系统](docs/subsystems/README.md)）。

## 怎么让 agent 做对

agent 照着已有的代码抄，走最短的路，所以要让容易的写法就是对的写法。挡住一类问题，按下面的顺序选手段，能用前面的就不用后面的（[理由](docs/subsystems/process.md)）：

1. **代码**：更好的结构、更强的类型和不变量、清楚的边界；用代码把一类问题整个消掉，以后不用再想它。
2. **静态检查**：lint 规则、测试、CI、形式化验证（如 TLA+）；花的 token 最少，问题在落地前就报出来。
3. **文字**：注释、规矩、本文、skill，只写没法强制、要 agent 自己判断的；能少写就少写。只有跑起来才看得出对不对的，写成验证 skill（[.agents/skills](.agents/skills/README.md)，照 [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) 写）。
4. **人看**：最难扩展。agent 落代码太快，每个 PR 都细看做不到；人的精力花在杠杆最大的地方：设计让 agent 默认就做对的环境。

一条新规矩，先问能不能写成代码或检查；只有写不成的，才进下面的列表。

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

## 规矩

- **先有概念，再有皮**：服务端按实际的概念分模块（工单、执行、项目、群聊……，[概念](docs/concepts.md)）；农场只画它们，每个农场里的东西都对得上一件实际的事；游戏规则只读事件、算画面，业务不调它（[提案](.agents/notes/proposed/architecture/2026-10-15-concepts-first.md)）。
- **核心状态只有一份**：帮工或农场的新状态，在 `packages/protocol/src/shapes.ts` 里加字段或事实，在 `apps/server/src/projection/reduce.ts` 的 `reduce` 里折，只由服务端 `Core.apply` 施加。不要在服务端、页面里另存一份帮工的状态（[理由](docs/subsystems/core.md)）。
- **`packages/protocol` 只放契约**：线上的形状写在 `shapes.ts`，每个形状在 `schema.ts` 有一个由它定类型的 Schema（`Codec<T.X>`：两边对不上就编不过），接口写在 `api.ts`；`src/rules` 只放页面和服务端都要跑的纯函数，只有服务端跑的规则归拥有它的模块（`apps/server/src/<模块>`），结论写进帧给页面，页面不为了展示去调规则（`rules/contract.test.ts` 查每个导出都有服务端以外的包在用）；黄金数据（`apps/server/src/<模块>/testdata/*.jsonl.gz`）跟着规则走，有意改了规则就 `bun run golden:update` 重写，看过 diff 再留（[理由](docs/subsystems/foundation.md)）。
- **生成的不手改**：`apps/server/db/generated` 由 effect-sqlc 写（`bun run db:generate`），`server:check` 查它是不是最新；`packages/protocol/src/client.ts` 由 `bun run api:client` 写，`docs:verify` 查它（[理由](docs/subsystems/foundation.md)）。
- **表名是「模块_概念」**：单数，`<模块>` 或 `<模块>_<概念>`，模块是拥有它的 `apps/server/src` 文件夹（`issue`、`issue_session`、`channel_message`、`session_run`）；索引以表名开头；SQL 只写在 `db/queries/<表>.sql`，一张表一个文件，代码里只调生成的；`src/base/schema.test.ts` 查这几条（[理由](docs/subsystems/foundation.md)）。
- **内部不留兼容**：架构还在成形，不为兼容少走一步：改名、改形状、改存盘的格式（库里的表、家目录的文件、环境变量、存下的取值）都直接改，不写兼容层，不在读的地方兜底旧数据，也不写数据搬运；表结构直接改 `db/migrations/0001_schema.up.sql`，不另加迁移（`schema.test.ts` 查这条），本机的旧库和旧文件作废（库由服务端开机时挪到一边、新建一个），旧文件删掉重建；启动时只认今天的名字（[理由](docs/subsystems/foundation.md)）。对外 HTTP 的版本是唯一例外，v1 留到主人的设备都升上来（[接口版本](docs/subsystems/core.md#为什么这样)）。
- **页面不折事实**：它读 `GET /api/v1/state` 折好的 `StateFrame`（`useCore()`、`useFrames()`）；要新的数据就加进 protocol 的字段和 `reduce`，页面里只写跟着时钟走的画面和摆法（`apps/web/src/rules`）；服务端的规则（能不能派、下回想起什么、冲突怎么交代）不在页面里重写，加一个字段或接口问服务端（[理由](docs/subsystems/app.md)）。
- **封闭的联合穷尽处理**：按 `_tag`、`kind`、`type` 分支的地方，`switch` 覆盖每一种并让 TypeScript 查到漏掉的（返回值的类型、`never`）；成员表（`XValues`）要每种都处理时用 `Record<X, …>`，加新成员时编不过。
- **服务端的服务**：每个模块导出一个服务（`class X extends Context.Service<X, XShape>()("vibevalley/X")`）、一个 `make`（`Effect.gen` 里 `yield*` 它用到的服务，不拿整个农场）和一个 `layer`；`services.ts` 按次序把 layer 叠起来，模块只用排在它前面的，往上走流（`Stream`，新闻、变化）；开机就要做的放 `start`、`ready` 这类 layer，叠在最后；服务之间传的形状放在定义它的模块里（[architecture.md](docs/architecture.md)）。
- **处理函数要薄**：接口的处理（`handlers.ts`、`http/`）和页面只做转发和展示，规则在拥有它的服务或纯函数里。
- **帮工没有权限确认**：服务端只听 127.0.0.1，永远不要对外；帮工只在工作目录里开工（[理由](docs/subsystems/session.md)）。例外只有两个，都是单独的监听：语音线路只有一个接口、每通电话一把钥匙，经隧道给声网（[理由](docs/subsystems/voice.md)）；「连接到本机」默认关着，只放主人在本机点过头的设备、每台一把钥匙，不放 `/mcp`（[理由](docs/subsystems/lan.md)）。
- **图标是像素素材**：界面上的按钮图标用 `design/pixel` 生成的贴图（`apps/web/public/pixel`，`<Icon>`；形状照 Hugeicons：`icons/ref.py`、`gen.sh`、`process.py`），不用 ▶、■、✓ 这类字符代替（[流程](docs/subsystems/process.md)）。
- **密钥**：写了钥匙的 `vibevalley.yaml`（`$VIBEVALLEY_HOME/vibevalley.yaml` 或 `--config` 给的）、`.agora/` 不进仓库；日志和文档里不出现密钥。
- **工具链**：Vite+（`vp`）管装依赖、格式、lint 和页面的构建，配置在根目录 `vite.config.ts`；依赖的版本只写在 `pnpm-workspace.yaml` 的 catalog，`package.json` 写 `catalog:`（[地基](docs/subsystems/foundation.md)）；`bun run check`（`vp check`）查格式（oxfmt，160 列；Markdown、生成的和数据不排）、oxlint（带类型的规则）和类型，`bun run check:fix` 改格式；各包的 `check` 另用 `tsc --noEmit`。测试用 `vp test`（vitest，跑在 Node 上，测试从 `vite-plus/test` import；服务端另用 `@effect/vitest`），每个包的 `vite.config.ts` 写它的 `test`（哪些文件、时区）；`scripts/` 的也用 `vp test`；界面和整个应用用 Playwright；脚本用 `vpx` 直接跑 `.ts`，都不带构建。
- **代码风格**：代码和接口用实际的概念，界面上的字用中文（[用语表](docs/README.md#用语)）；工单的状态和动作在哪里都用工单自己的词（完成、改动、问题、计划，词表在 `packages/protocol/src/rules`），种地的词（收获、缺肥、种植计划……）只在农场的皮里，`stale-names.ts` 查（[状态和用语](docs/subsystems/issue.md#状态和用语)）；注释用英文，只写不看就会写错或改错的：为什么、顺序和锁、安全边界、格式和取值、要和别处保持一致的，不复述代码、不写概述和历史（[建议和不建议的写法](docs/style/code.md)）。
- **测试**：服务端的测试用 oar 的 `scriptedRuntime`（`@botiverse/oar/testing`）扮演帮工、用真的 git 仓库（`src/testing/git.ts`）、模型用 pi-ai 的 faux（`agent/brain/testing.ts`），不连网，`src/testing/world.ts` 搭一个整农场，跨好几个模块的流程写在 `src/flows`（帮工照工单的字眼干活，`src/testing/helper.ts`）；纯函数的规则直接测；页面的 Playwright 对着真的服务端，测试的服务端拿到的环境去掉了一切钥匙，`HOME` 也是临时的，不问这台机器上的编码 agent：pi 换成同一个照字眼干活的帮工、别的 runtime 都当没装（`VIBEVALLEY_TEST_RUNTIMES`），派活、提问、交活都能真走一遍，不用手搓帧。改了帮工、项目、工单的状态和完成、核心状态或游戏规则的行为，补对应的测试。
- **改完要验证**：先跑最窄的检查；改了接口、服务、页面或手机壳，照 [acceptance](.agents/skills/acceptance/SKILL.md) 找到对应的分册，在真的程序上看一遍，汇报时附上它要的证据；一类改动没有分册，又花了工夫才验证完，就照 `create-verification-skill` 补一份（[.agents/skills](.agents/skills/README.md)）。
- **分支、提交和 PR**：`main` 只经 PR、squash 合并，CI 全过才能合；分支 `<类>/<主题>`，提交和 PR 的标题、正文用英文，标题一句话说改完以后的行为、最多 100 字，不带 agent 署名；commit-msg hook 和 CI 查，开、改、合照 [vv-pr](.agents/skills/vv-pr/SKILL.md)（[规矩](docs/development.md#分支提交和-pr)）。
- **文档和 Note**：改了行为就在同一个改动里改文档；有子系统文档（`docs/subsystems/`）的，改它，不在 `reference/` 另写一份；非平凡的工作先写计划 Note（行为、模块边界、共享约定、持久化格式、流程、测试策略），做完把仍然成立的沉淀进子系统、删掉 Note；局部的、机械的改动和界面微调不用写（[规矩](.agents/notes/README.md#什么时候写)）。

## 编辑本文

`CLAUDE.md` 只有一行 `@AGENTS.md`，引用本文；规矩都改在本文。每条规矩自成一句，细节链接到它的家。
