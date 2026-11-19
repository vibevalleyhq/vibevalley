# AGENTS.md

VibeValley 是 AI 版的 Linear，一个在本机管编码 agent 的工作台，和 Multica 是一类东西：工单派给 agent 档案，服务端为它派一个帮工（经 Rust 的 oar 驱动本机的编码 agent），按档案设置在仓库目录或工单的 worktree 里一轮一轮干活，用户看改动、合进主分支；用户、助手（替用户派活的 agent）和帮工在群聊里说话。外面画成一座农场：仓库是岛，在做的工单是一块地，帮工在地上干活，群聊是田头（[概念](docs/concepts.md)）。它是全原生的，只支持 macOS，只在本机用：服务端和命令行是 Rust（`crates/`），应用是 `apps/mac`（GPUI 窗口，里面带着服务端；工作台是 nsh 跑的 TSX 页面，像素农场由 Rust 画）；契约、词典、工具说明和提示以 Rust 为源，TS 由它生成。还在做的部分见[原生计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)。改 `crates/`、`apps/`、`packages/` 之前读 [docs/architecture.md](docs/architecture.md)；写文档照 [docs/AGENTS.md](docs/AGENTS.md) 和 [docs/style/writing.md](docs/style/writing.md)；子系统沉淀在 [docs/subsystems](docs/subsystems/README.md)，计划写成 [Agent Notes](.agents/notes/README.md)。

## 目录

```
crates/vibevalley-server/  服务端（二进制 vibevalley-server）：src/modules 按单数概念分深模块（agent、artifact、attachment、channel、cron、game、issue、
                           ledger、library、media、memory、mcp、orchestrator、pkm、provider、publish、repo、session、setting、tool、watch、workplace；
                           工单板拆成 issue（状态与交付）、session（帮工和每一轮）、workplace（worktree 与合并），都只经 ledger 写），lib.rs 组装 Hub，
                           start.rs 起服务，main.rs 读参数和环境；assets/ 是工具说明（tools/）、助手和帮工的提示
crates/vibevalley-http/    HTTP 门（/api/v1、SSE、/mcp）：照契约的接口表把请求交给服务端
crates/vibevalley-server-api/  服务端对桥和 HTTP 门的接口（Server trait）
crates/vibevalley-bridge/  页面和进程内服务端之间的桥（Hub），和顶替服务端的样例（fake）
crates/vibevalley-core/    核心状态与规则：reduce、frame_of、工单的状态和阶段、收件箱、巡查、农场的画面、简报和起草
crates/vibevalley-protocol/  契约的源：src/contract 一个概念一个文件；typescript.rs 写出 packages/protocol 的 shapes.gen.ts 和 endpoints.gen.ts
crates/vibevalley-oar/     oar 的 Rust 实现：Claude Code、Codex、ACP、自研 vibevalley 和测试用的 scripted 农机
crates/vibevalley-agent/   VibeValley 自己的 agent：模型请求（DeepSeek）、工具、对话循环和压缩
crates/vibevalley-cli/     命令行（二进制 vibevalley，clap）：照领域模型一条命令一个操作，经 HTTP 调服务端
crates/vibevalley-home/    家目录在磁盘上的约定：在哪、server.json、语言；服务端、命令行、原生应用共用
crates/vibevalley-i18n/    对用户说的话：locales/<语言>/<宿主.模块>.json 的词典，Rust 里 t("key")
crates/vibevalley-*        其余：git、files、terminal、workspace 和 store（应用外壳的项目、布局、终端）、memory、pkm、artifact、cron
apps/mac/                  原生应用（二进制 vibevalley-mac）：src/ 是窗口外壳、终端、宿主能力和像素场景（src/pixel：农场、地图、记忆树、开场、图鉴）；
                           ui/ 是 nsh 跑的 TSX：surfaces/ 和 components/ 是外壳的面，vv/web/ 是工作台（app、features/<概念>、ui、state、infra、base）
apps/island/               刘海上的灵动岛（Swift）：单独的小程序（apps/island/README.md）
apps/site/                 官网 vibevalley.dev（Vite + Solid 2 静态生成），图和像素字用根目录 assets/ 的
assets/                    全部的图、像素字、指针和像素村的地图
packages/protocol/         页面用的契约：src/<概念>/shapes.gen.ts 和 endpoints.gen.ts 是生成的；Zod（schema.ts）、端点表（api.ts）、双端规则（rules/）、
                           client.ts、宿主接口（host.ts）是手写的
packages/i18n/             页面里 t("key")：src/catalogs.ts 由 i18n:gen 从 crates/vibevalley-i18n/locales 写出
packages/pkm/、artifact/   笔记和 Artifact 在页面这边的纯逻辑；和 Rust 的同名 crate 共用 golden
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
cargo run -p vibevalley-mac                                     # 原生应用，里面带着服务端；VIBEVALLEY_HOME 改家目录
cargo run -p vibevalley-server                                  # 只跑服务端，127.0.0.1:8787；VIBEVALLEY_HOME、VIBEVALLEY_WORK_ROOT、VIBEVALLEY_PORT 改位置
cargo run -p vibevalley-cli -- issue list                       # 命令行：issue、channel、repo、agent、session、runtime、memory、cron、artifact、pkm、setting、chat、doctor
vp run rust:check                                               # 改完 crates/ 或 apps/mac/src：cargo fmt、clippy（-D warnings）、cargo test
vp run protocol:ts                                              # 改了 crates/vibevalley-protocol/src/contract：重写 packages/protocol 的 shapes.gen.ts 和 endpoints.gen.ts
sqlc generate                                                   # 改完 SQLite 表结构或命名查询：重写各模块的 generated/queries.rs
vp run sql:check                                                # 用 sqlc 1.31.1 对账 Rust 绑定；用 Python 3 的 SQLite 按参数个数预编译每条查询
vp run goldens                                                  # 改了 packages/pkm、packages/artifact 的规则：重写两个 crate 的 golden
vp run protocol:check                                           # 生成的 TS 契约和两份 golden 是不是最新，和提交的不同就失败
vp run mac:check                                                # 改完 apps/mac/ui：nsh 类型检查、打包和工单按钮行为测试
vp check                                                        # 改完 apps/mac/ui 以外的 TS：格式（oxfmt）、lint（oxlint，带类型，跑在 tsrs 上）和类型；--fix 改格式
vp run packages:check                                           # 改完 packages/：打出声明、vp check、各包的测试
vp run scripts:test                                             # 改完 scripts/：它自己的测试
vp run site:check && vp run site:build                          # 改完 apps/site/：素材和静态生成测试，再构建
vp run docs:verify                                              # 改完文档、Note 或 skill：格式、目录、链接、旧名字、用语、词典和生成的参考表
vp run notes:catalog                                            # 加、挪、删 Note 或改了标题：重写 .agents/notes/CATALOG.md
vp run i18n:gen                                                 # 改了 crates/vibevalley-i18n/locales：重写 catalogs.ts；vpx scripts/gen/i18n.ts check|find <文字> 查问题、找键
vp run capabilities                                             # 改了 <概念>/api.ts 的 can：重写 docs/reference/capabilities.md
vp run api:client                                               # 改了 <概念>/api.ts 的接口：重写 packages/protocol/src/client.ts
vp run deadcode                                                 # knip 查 TS 里没人用的文件、导出和依赖
vpx scripts/audit/comment-review.ts                             # 提 PR 前：模型审这个分支新加的注释（vv-comments）
vp run release:verify                                           # 在 Mac 上检查 Rust、契约、SQL、软件包、脚本、原生页面和文档
vp run release alpha|beta|final                                 # beta/final 先跑 release:verify；确认后推 tag，每个标签通过 CI 才打包
```

Rust 照 `rust-toolchain.toml`，Node 24（`.node-version`），Vite+（`vp`：pnpm 12、格式、lint、类型、测试、任务）。先跑和改动有关的最窄的检查。服务端不自动重载：改了 `crates/` 要重新构建、重启它。

一件事的主线：oar 的会话事件 → 服务端读成事实 → `vibevalley-core` 的 `reduce` 折进核心状态 → 折好的 `StateFrame` 经桥推给应用里的页面（HTTP 门上是 `GET /api/v1/state` 的 SSE）；会话和助手的每一步记成轨迹（[architecture.md](docs/architecture.md)、[子系统](docs/subsystems/README.md)）。

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
- **核心状态只有一份**：帮工或农场的新状态加进契约的形状与事实，在 `vibevalley-core` 的 `reduce` 里折叠，只经事实施加，不在服务端或页面另存一份（[核心状态](docs/subsystems/core.md)）。
- **边界解码一次，门内全是类型**：HTTP、文件、厂商响应、模型给的工具参数，各在进门处用 serde 解码成结构体和 enum；门内不传 `serde_json::Value`、不按字符串分支；钥匙包进 `Secret`（打印只出提示）；页面在边界用 Zod 解码（`satisfies Codec<T.X>`）（[类型驱动与进门解码](docs/style/module-design.md)）。
- **深模块**：每个模块对外一个窄接口；不靠一个带 `kind` 的入口复用多种操作（[模块设计](docs/style/module-design.md)）。
- **封闭的联合穷尽处理**：Rust 的 `match` 不写吞掉新成员的 `_`；TS 按 `_tag`、`kind`、`type` 分支时 `switch` 覆盖全部成员（`switch-exhaustiveness-check` 查）。
- **契约改在 Rust**：形状和接口表改 `crates/vibevalley-protocol/src/contract`，TS 的类型由它生成；页面要用的同改手写的 `schema.ts` 与 `api.ts`，它们的测试对着生成物查（[契约](docs/subsystems/foundation.md#契约规则和数据库)）。
- **生成的不手改**：`packages/protocol` 的 `shapes.gen.ts` 与 `endpoints.gen.ts`（`protocol:ts`）、`client.ts`（`api:client`）、`packages/i18n/src/catalogs.ts`（`i18n:gen`）、artifact 与 pkm 的 golden（`goldens`）和生成的参考表由脚本写出，`protocol:check` 和 `docs:verify` 查是不是最新。SQLite 查询绑定由 sqlc 生成，输入和输出见[配置](sqlc.yaml)。
- **内部不留兼容**：改名、改形状、改落盘格式直接改，不写兼容层、旧数据兜底或迁移脚本；对外 HTTP `v1` 是唯一例外（[接口版本](docs/subsystems/core.md)）。
- **页面不折事实**：页面只读推来的 `StateFrame` 并写画面摆法，请求只经 `Transport`；缺数据就补进契约与 `reduce` 或调接口问服务端（[客户端](docs/subsystems/app.md)）。
- **处理函数要薄**：HTTP 门、桥和页面组件只做转发与展示，规则留在所属模块或纯函数里（[架构](docs/architecture.md)）。
- **帮工没有权限确认**：服务端只听 `127.0.0.1`，帮工只在工作目录开工（[帮工](docs/subsystems/session.md)）。
- **包之间只经包名**：TS 跨包只经 `package.json` 的 `exports` 写 `@vibevalley/*`（`no-cross-package-path` 查）；Rust 跨 crate 只经 `Cargo.toml` 的依赖。
- **图标分两套**：工作台用 `apps/mac/ui/vv/web/ui/icons.ts` 注册的 reicon 线条图标（`<Icon name>`），像素皮与头像、农机 logo 用 `design/pixel` 生成的像素图，都不用字符符号代替（[图标](docs/style/design.md#图标)）。
- **界面照田间工作台**：工作台的颜色、圆角、字号、阴影和缓动一律走令牌（`apps/mac/ui/vv/theme.json` 与 `apps/mac/ui/nsh.json`），外壳的走 `apps/mac/ui/tokens.ts` 与 `apps/mac/src/theme.rs`；照 [界面怎么做](docs/style/design.md)，class 写法照 [vv-tailwind](.agents/skills/vv-tailwind/SKILL.md)。
- **密钥**：家目录的 `settings.json` 不进仓库；日志、快照和文档里不出现真实密钥。
- **话放在哪**：对用户的话进 `crates/vibevalley-i18n/locales/{zh,en}/<宿主.模块>.json`，Rust 调 `vibevalley_i18n::t`，TS 调 `t("key")`（`vpx scripts/gen/i18n.ts check` 查漏翻）；对模型的话用中文写进 `crates/vibevalley-server/assets`（[话放在哪](docs/subsystems/foundation.md)）。
- **代码风格**：代码和接口用实际业务概念，种地双关只留在农场的皮里（`stale-names.ts` 查，[用语表](docs/README.md#用语)）；命名站在领域视角说管什么事，不用 `utils`、`state` 一类泛词（[命名](docs/style/naming.md)）；英文注释只写不看就会改错的约束与原因（[代码风格](docs/style/code.md)）。
- **测试**：行为在能发现出错的最低层测；服务端的测试在 `crates/*/tests`，用 scripted 农机与真 git 离线跑；页面的测试用 `nsh/test` 喂样例的 `Transport`，像素场景在 CPU 上画出来查；不写硬编码睡眠等待（TS 由 `no-test-sleep` 查）；修缺陷补 `regression` 测试。
- **改完要验证**：先跑最窄的静态与单元检查；改了接口、服务、页面或像素场景，照 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 在真实程序上验收并附上证据。
- **分支、提交和 PR**：同批改动默认合一个 PR，只经 squash 合入 `main`；分支 `<类>/<主题>`，提交与 PR 用英文写改完后的行为（标题不超过 100 字符、不带 agent 署名，commit-msg hook 与 CI 查），操作照 [vv-pr](.agents/skills/vv-pr/SKILL.md)（[分支、提交和 PR](docs/development.md)）。
- **文档和 Note**：改行为同改对应文档（优先改 `docs/subsystems/`，见 [文档规矩](docs/AGENTS.md)）；非平凡改动先写 `proposed/` Note，上线后把长期成立的沉淀进子系统并删掉 Note（[什么时候写](.agents/notes/README.md#什么时候写)）。

## 编辑本文

`CLAUDE.md` 只有一行 `@AGENTS.md`，引用本文；规矩都改在本文。每条规矩自成一句，细节链接到它的家。
