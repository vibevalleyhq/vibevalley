# AGENTS.md

VibeValley 是 AI 版的 Linear，一个在本机管编码 agent 的工作台，和 Multica 是一类东西：任务派给角色（Agent），服务端为它派一个执行会话（Session，经 Rust 的 oar 驱动本机的编码引擎），按角色设置在仓库目录或任务的 worktree 里一轮一轮运行，用户看改动、合进主分支；用户、主助手（替用户派活的 agent）和执行会话在频道里说话。外面另有一层像素农场皮肤：仓库是岛，在做的任务是一块地，帮工在地上干活，默认频道画成田头（[概念](docs/concepts.md)）。它是全原生的，桌面宿主运行于 macOS：服务端和命令行是 Rust（`crates/`），桌面应用是 `apps/mac`（GPUI 窗口，里面带着服务端；工作台是 nsh 跑的 TSX 页面，像素农场由 Rust 画），另提供独立原生移动端 `apps/mobile`（`nsh/mobile`，iOS 优先、Android 就绪，经默认关闭的 Tailscale / 回环受认证远程门接入 Mac，见[移动远程控制方案](.agents/notes/proposed/architecture/2026-11-23-mobile-remote-tailscale-nsh.md)）；契约、词典、工具说明和提示以 Rust 为源，TS 由它生成。还在做的部分见[原生计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)。改 `crates/`、`apps/`、`packages/` 之前读 [docs/architecture.md](docs/architecture.md)；写文档照 [docs/AGENTS.md](docs/AGENTS.md) 和 [docs/style/writing.md](docs/style/writing.md)；子系统沉淀在 [docs/subsystems](docs/subsystems/README.md)，计划写成 [Agent Notes](.agents/notes/README.md)。

## 目录

```
crates/protocol/           契约与环境约定（vibevalley-protocol）：src/contract/ 一个概念一个文件，typescript.rs 写出 packages/protocol 的 shapes.gen.ts 和 endpoints.gen.ts；home.rs 为家目录与 server.json 约定
crates/i18n/               对用户说的话（vibevalley-i18n）：locales/<语言>/<宿主.模块>.json 的词典，Rust 里 t("key")
crates/core/               核心状态与纯规则（vibevalley-core）：reduce、SliceMask 与按域切片投影（board/sessions/collab/inbox/ops/farm）、任务状态和阶段、收件箱、巡查、农场画面、简报起草、定时任务（cron/）、笔记大纲（pkm/）与作品引擎（artifact/）
crates/git/ · files/       仓库 Git 封装（vibevalley-git）与工作区文件搜索和监听（vibevalley-files）
crates/runtime/            运行时与自研 agent（vibevalley-runtime）：rt（进程共享 Tokio 运行时）、oar/ 驱动（Claude Code、Codex、ACP、scripted；含基于 arc-swap 的零开销 OarObserver 与 oar-voyage/3 记录）与 agent/ 模型请求（DeepSeek，reqwest + backon）、持久执行引擎、工具、对话循环和内置 vibevalley 运行时
crates/engines/            底层引擎：纯 Rust 正则（onig）、语法高亮（shiki）与图谱渲染（pele），供 crates/rich 使用
crates/rich/               原生富内容组件与辅助（vibevalley-rich）：Markdown、代码块、图谱、画布、图表、GenUI 与拼音匹配（engine/ 含 canvas、chart、genui、pinyin）
crates/server/             服务端（二进制 vibevalley-server）：src/modules 按 6 个业务域分组（work：issue、session、workplace、repo、cron、pull、ledger；
                           team：agent、orchestrator、memory、tool、mcp；collab：channel、connector、voice；
                           content：attachment、library、media、artifact、pkm；skin：game；infra：setting、provider、http、column、debug、remote；
                           任务板拆成 work/issue（状态与交付）、work/session（领域无关 AgentSession、SQLite session_mailbox 与游标轨迹 session_event）、work/workplace（worktree 与合并），都只经 work/ledger 写），
                           src/db/{schema,queries,generated}/ 集中管理 SQLite 建表语句（含 shared.sql 共享 seq_counter 与 infra_remote.sql 远程配置/设备表）、命名查询与 sqlc 生成绑定；
                           src/transport/ 收拢接口契约（api）、进程内桥（bridge）与 HTTP 门（http，含默认关闭的受认证远程监听门）；
                           lib.rs 组装 Hub（含 EventBus、SliceFeed、CallerContext 与观察/故障/宿主调试/远程认证插槽），start.rs 起服务，main.rs 读参数和环境；assets/ 是工具说明（tools/）、作品类型指南（artifact/types/）、主助手和执行会话的提示
crates/cli/                命令行（二进制 vibevalley，clap）：按五大业务域（work/team/collab/content/infra）组织的纯 HTTP 客户端；评测另拆为可选二进制 vibevalley-eval（--features eval）
apps/mac/                  原生应用（二进制 vibevalley-mac）：src/ 是窗口外壳（src/shell/*）、终端、宿主能力和像素场景（src/pixel：农场、地图、记忆树、开场、图鉴）；
                           crates/ 是桌面独占支撑 crate（pixel、terminal、workspace）；
                           ui/ 是 nsh 跑的 TSX：app（含 6 项主导航，详见 docs/subsystems/app.md）、workspace（侧栏/Git/文件/命令面板）、design（共享令牌与组件）、features/<概念>（含笔记与作品前端引擎、5 栏设置与远程访问面板）、farm、infra
apps/mobile/               独立原生移动应用（nsh/mobile，iOS 优先、Android 就绪）：经 @vibevalley/protocol/remote 连接 Mac 远程门，4 标签页（收件箱、频道、会话、任务）与 97 枚 reicons 矢量回退
apps/island/               刘海上的灵动岛（Swift）：单独的小程序（apps/island/README.md）
apps/site/                 官网 vibevalley.dev（Vite + Solid 2 静态生成），图和像素字用根目录 assets/ 的
assets/                    全部的图、像素字、指针和像素村的地图
packages/protocol/         页面用的契约：src/<概念>/shapes.gen.ts 和 endpoints.gen.ts 是生成的；Zod（schema.ts）、端点表（api.ts）、双端规则（rules/）、
                           纯 Web Fetch 远程传输层（@vibevalley/protocol/remote：remote/transport.ts）、client.ts、宿主接口（host.ts）是手写的
packages/i18n/             页面里 t("key")：src/catalogs.ts 由 i18n:gen 从 crates/i18n/locales 写出
packages/testkit/、tsrs/   测试共用的；vp check 用的 TypeScript（tsrs）
design/                    生图提示词、脚本和切图规则；原图在单独的仓库 vibevalley-art，design/art.sh 链接进来
docs/                      当前的行为和约定；subsystems/ 是各子系统从架构角度沉淀下来的样子（docs/AGENTS.md）
.agents/notes/             Agent Notes：具体的计划，做完沉淀进 docs/subsystems
.agents/skills/            仓库自己的 skill：验收（vv-acceptance）等；.claude/skills 链接到这里
scripts/                   gen/（生成物写出）、audit/（lint 插件、死代码、注释审查）、docs/（Note、链接、术语与旧名检查）、release/（发版、回归与验收沙箱 verify-server.ts）
```

每个包的约定在它的 README。

## 命令

```bash
vp install                                                      # 根目录：装 TS 依赖（Vite+ 带的 pnpm 12），打出各包的声明
vp run nsh:install                                              # 把 nsh 的命令行装到 .tools/bin：打 apps/mac/ui 的包、跑 mac:check 之前
cargo run -p vibevalley-mac                                     # 原生应用，里面带着服务端；dev 通道默认 127.0.0.1:8790 与 ~/.vibevalley-dev，VIBEVALLEY_HOME、VIBEVALLEY_STORE 改位置
cargo run -p vibevalley-server                                  # 只跑服务端；按发布通道默认端口（dev 8790 / alpha 8789 / beta 8788 / release 8787），VIBEVALLEY_CHANNEL、VIBEVALLEY_HOME、VIBEVALLEY_WORK_ROOT、VIBEVALLEY_PORT 改位置
cargo run -p vibevalley-cli -- issue list                       # 命令行：issue、session、repo、cron、agent、orchestrator、runtime、memory、channel、chat、artifact、pkm、library、media、attachment、state、setting、doctor（--json 输出原始 JSON）
vp run rust:check                                               # 改完 crates/ 或 apps/mac/src：cargo fmt、clippy（-D warnings）、cargo test
vp run rust:changed                                             # 只检查相对 origin/main 改到的 Rust crate 及其反向依赖（fmt、clippy、nextest）
vp run protocol:ts                                              # 改了 crates/protocol/src/contract：重写 packages/protocol 的 shapes.gen.ts 和 endpoints.gen.ts
sqlc generate                                                   # 改完 SQLite 表结构或命名查询：重写 crates/server/src/db/generated/ 与宿主查询绑定
vp run sql:check                                                # 用 sqlc 1.31.1 对账 Rust 绑定；用 Python 3 的 SQLite 按参数个数预编译每条查询
vp run goldens                                                  # 改了笔记/作品规则或对照用例：跑 Rust 两个 crate 的 golden 测试
vp run protocol:check                                           # 生成的 TS 契约和两份 golden 是不是最新，和提交的不同就失败
vp run mac:check                                                # 改完 apps/mac/ui：nsh 类型检查、打包和工单按钮行为测试
vp run mobile:check                                             # 改完 apps/mobile：nsh 类型检查、打包、测试与 lint
vp run icons:gen                                                # 改了 crates/rich/src/icon.rs：重新生成 97 枚 reicons 矢量路径表 iconPaths.gen.ts
vp check                                                        # 改完 apps/mac/ui 以外的 TS：格式（oxfmt）、lint（oxlint，带类型，跑在 tsrs 上）和类型；--fix 改格式
vp run packages:check                                           # 改完 packages/：打出声明、vp check、各包的测试
vp run scripts:test                                             # 改完 scripts/：它自己的测试
vp run site:check && vp run site:build                          # 改完 apps/site/：素材和静态生成测试，再构建
vp run docs:verify                                              # 改完文档、Note 或 skill：格式、目录、链接、旧名字、用语、词典和生成的参考表
vp run notes:catalog                                            # 加、挪、删 Note 或改了标题：重写 .agents/notes/CATALOG.md
vp run i18n:gen                                                 # 改了 crates/i18n/locales：重写 catalogs.ts；vpx scripts/gen/i18n.ts check|find <文字> 查问题、找键
vp run capabilities                                             # 改了 <概念>/api.ts 的 can：重写 docs/reference/capabilities.md
vp run api:client                                               # 改了 <概念>/api.ts 的接口：重写 packages/protocol/src/client.ts
vp run deadcode                                                 # knip 查 TS 里没人用的文件、导出和依赖
vpx scripts/audit/comment-review.ts                             # 提 PR 前：模型审这个分支新加的注释（vv-comments）
vp run release:verify                                           # 在 Mac 上检查 Rust、契约、SQL、软件包、脚本、原生页面和文档
vp run release alpha|beta|final                                 # beta/final 先跑 release:verify；确认后推 tag，每个标签通过 CI 才打包
```

Rust 照 `rust-toolchain.toml`，Node 24（`.node-version`），Vite+（`vp`：pnpm 12、格式、lint、类型、测试、任务）。先跑和改动有关的最窄的检查。服务端不自动重载：改了 `crates/` 要重新构建、重启它。

一件事的主线：oar 的会话事件 → 服务端读成事实 → `vibevalley-core` 的 `reduce` 折进核心状态并输出脏掩码 `SliceMask` → 各域独立切片（`board`、`sessions`、`collab`、`inbox`、`ops` 与 `farm`）经 `SliceFeed` 与桥推给应用里的页面（HTTP 门上是 `GET /api/v1/slice/{name}` 的 SSE 或快照）；执行会话和主助手的每一步记成轨迹（[architecture.md](docs/architecture.md)、[子系统](docs/subsystems/README.md)）。

## 怎么让 agent 做对

agent 照着已有的代码抄，走最短的路，所以要让容易的写法就是对的写法。挡住一类问题，按下面的顺序选手段，能用前面的就不用后面的（[理由](docs/subsystems/process.md)）：

1. **代码（类型与静态结构）**：清楚的模块边界、结构体和 enum 表达的不变量、进门一次解码；让非法状态不可编译，把一类问题整个消掉（[静态化、类型化与可分析化](docs/style/module-design.md)）。
2. **静态检查**：Rust 的类型、clippy（`-D warnings`）和测试；TS 一侧是严格的 TypeScript（tsrs）、带类型的 oxlint 和 nsh 的类型检查；失败时写清错在哪、怎么改、看哪个文件（[写法](docs/style/code.md)）。
3. **文字**：注释、规矩、本文、skill，只写没法强制、要 agent 自己判断的；只有跑起来才看得出对不对的，写成验证 skill（[.agents/skills](.agents/skills/README.md)，照 [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) 写）。
4. **人看**：最难扩展；人的精力花在设计让 agent 默认就做对的环境上。

一条新规矩，先问能不能写成类型、clippy 规则或测试；只有写不成的，才进下面的列表。

## 规矩

- **Rust 为准，速度优先**：服务端的行为以 Rust 为准；成本高、价值低的就砍掉或简化，记进[原生计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)的「砍掉的」。
- **先有概念，再有皮**：服务端按实际概念分模块（[概念](docs/concepts.md)）；农场只画它们，游戏规则只读事件算画面，业务不调它（[农场的皮](docs/subsystems/farm.md)）。
- **核心状态只有一份**：执行会话或农场的新状态加进契约的形状与事实，在 `vibevalley-core` 的 `reduce` 里折叠，只经事实施加，不在服务端或页面另存一份（[核心状态](docs/subsystems/core.md)）。
- **边界解码一次，门内全是类型**：HTTP、文件、厂商响应、模型给的工具参数，各在进门处用 serde 解码成结构体和 enum；门内不传 `serde_json::Value`、不按字符串分支；钥匙包进 `Secret`（打印只出提示）；页面在边界用 Zod 解码（`satisfies Codec<T.X>`）（[类型驱动与进门解码](docs/style/module-design.md)）。
- **深模块**：每个模块对外一个窄接口；不靠一个带 `kind` 的入口复用多种操作（[模块设计](docs/style/module-design.md)）。
- **封闭的联合穷尽处理**：Rust 的 `match` 不写吞掉新成员的 `_`；TS 按 `_tag`、`kind`、`type` 分支时 `switch` 覆盖全部成员（`switch-exhaustiveness-check` 查）。
- **契约改在 Rust**：形状和接口表改 `crates/protocol/src/contract`，TS 的类型由它生成；页面要用的同改手写的 `schema.ts` 与 `api.ts`，它们的测试对着生成物查（[契约](docs/subsystems/foundation.md#契约规则和数据库)）。
- **生成的不手改**：`packages/protocol` 的 `shapes.gen.ts` 与 `endpoints.gen.ts`（`protocol:ts`）、`client.ts`（`api:client`）、`packages/i18n/src/catalogs.ts`（`i18n:gen`）、`iconPaths.gen.ts`（`icons:gen`）、artifact 与 pkm 的 golden（`goldens`）和生成的参考表由脚本写出，`protocol:check` 和 `docs:verify` 查是不是最新。SQLite 查询绑定由 sqlc 生成，输入和输出见[配置](sqlc.yaml)。
- **内部不留兼容**：改名、改形状、改落盘格式直接改，不写兼容层、旧数据兜底或迁移脚本；对外 HTTP `v1` 是唯一例外（[接口版本](docs/subsystems/core.md)）。
- **页面不折事实**：页面只读按域推来的切片（`board`、`sessions`、`collab`、`inbox`、`ops`、`farm`）并写画面摆法，请求只经 `Transport`；缺数据就补进契约与 `reduce` 或调接口问服务端（[客户端](docs/subsystems/app.md)）。
- **处理函数要薄**：HTTP 门、桥和页面组件只做转发与展示，规则留在所属模块或纯函数里（[架构](docs/architecture.md)）。
- **执行会话没有权限确认**：服务端只听 `127.0.0.1`，执行会话只在工作区开工（[执行会话](docs/subsystems/session.md)）。
- **包之间只经包名**：TS 跨包只经 `package.json` 的 `exports` 写 `@vibevalley/*`（`no-cross-package-path` 查）；Rust 跨 crate 只经 `Cargo.toml` 的依赖。
- **图标分两套**：工作台用 `crates/rich/src/icon.rs` 原生 `VvIcon` 渲染的 97 枚 reicon 线条图标（TS 侧由 `apps/mac/ui/design/icons.ts` 声明 `IconName`，经 `<Icon name>` 使用；无原生 `VvIcon` 的载体及 `apps/mobile` 使用 `scripts/gen/icons.ts` 单源生成的 `iconPaths.gen.ts` 与 `<Canvas>` + `Path2D` 矢量回退），像素皮与头像、引擎 logo 用 `design/pixel` 生成的像素图，都不用字符符号代替（[图标与令牌](docs/design/01-philosophy-and-tokens.md)）。
- **界面照田间工作台**：工作台、工作区外壳、移动端和原生壳面的颜色、圆角、字号、阴影和缓动一律走 `design/tokens.json`（由 `vp run tokens:gen` 同步写出 `apps/mac/ui/design/theme.json`、`apps/mac/ui/nsh.json`、`apps/mac/src/theme_tokens.rs` 及 `apps/mobile` 令牌）；照 [设计系统](docs/design/README.md) 与 [Agent UI 指南](docs/design/08-agent-ui-guide.md)，class 写法照 [vv-tailwind](.agents/skills/vv-tailwind/SKILL.md)。
- **密钥**：家目录的 `settings.json` 不进仓库；日志、快照和文档里不出现真实密钥。
- **话放在哪**：对用户的话进 `crates/i18n/locales/{zh,en}/<宿主.模块>.json`，Rust 调 `vibevalley_i18n::t`，TS 调 `t("key")`（`vpx scripts/gen/i18n.ts check` 查漏翻）；对模型的话用中文写进 `crates/server/assets`（[话放在哪](docs/subsystems/foundation.md)）。
- **代码风格**：代码和接口用实际业务概念，种地双关只留在农场的皮里（`stale-names.ts` 查，[用语表](docs/README.md#用语)）；命名站在领域视角说管什么事，不用 `utils`、`state` 一类泛词（[命名](docs/style/naming.md)）；英文注释只写不看就会改错的约束与原因（[代码风格](docs/style/code.md)）。
- **测试**：行为在能发现出错的最低层测；服务端的测试在 `crates/*/tests`，用 scripted 引擎与真 git 离线跑；页面的测试用 `nsh/test` 喂样例的 `Transport`，像素场景在 CPU 上画出来查；不写硬编码睡眠等待（TS 由 `no-test-sleep` 查）；修缺陷补 `regression` 测试。
- **改完要验证**：先跑最窄的静态与单元检查；改了接口、服务、页面或像素场景，照 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 在真实程序上验收并附上证据。
- **分支、提交和 PR**：同批改动默认合一个 PR，只经 squash 合入 `main`；分支 `<类>/<主题>`，提交与 PR 用英文写改完后的行为（标题不超过 100 字符、不带 agent 署名，commit-msg hook 与 CI 查），操作照 [vv-pr](.agents/skills/vv-pr/SKILL.md)（[分支、提交和 PR](docs/development.md)）。
- **文档和 Note**：改行为同改对应文档（优先改 `docs/subsystems/`，见 [文档规矩](docs/AGENTS.md)）；非平凡改动先写 `proposed/` Note，上线后把长期成立的沉淀进子系统并删掉 Note（[什么时候写](.agents/notes/README.md#什么时候写)）。

## 编辑本文

`CLAUDE.md` 只有一行 `@AGENTS.md`，引用本文；规矩都改在本文。每条规矩自成一句，细节链接到它的家。
