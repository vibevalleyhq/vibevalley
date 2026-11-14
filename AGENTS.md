# AGENTS.md

VibeValley 是 AI 版的 Linear，一个在本机管编码 agent 的工作台，和 Multica 是一类东西：工单派给 agent 档案，服务端为它派一个帮工（经 Rust 的 oar 驱动本机的编码 agent），在 `VIBEVALLEY_WORK_ROOT` 下，按档案设置在仓库目录或工单的 worktree 里一轮一轮干活，用户看改动、合进主分支；用户、助手（替用户派活的 agent）和帮工在群聊里说话。外面画成一座农场：仓库是岛，在做的工单是一块地，帮工在地上干活，群聊是田头（[概念](docs/concepts.md)）。仓库正在改成全原生（[计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)）：服务端和命令行是 Rust（`crates/`），原生应用是 `apps/mac`（GPUI 窗口加 nsh 跑的 TSX 页面）；Solid 页面 `apps/web`、Electron 壳 `apps/desktop`（现在带着 Rust 服务端起来）和手机壳 `apps/mobile` 等到后面的闸再删。服务端和页面之间的契约现在写在 `packages/protocol`（zod），由 `crates/vibevalley-protocol/gen` 生成 Rust 类型。改 `crates/`、`apps/`、`packages/` 之前读 [docs/architecture.md](docs/architecture.md)；写文档照 [docs/AGENTS.md](docs/AGENTS.md) 和 [docs/style/writing.md](docs/style/writing.md)；子系统沉淀在 [docs/subsystems](docs/subsystems/README.md)，计划写成 [Agent Notes](.agents/notes/README.md)。

## 目录

```
crates/vibevalley-server/  服务端（二进制 vibevalley-server）：src/modules 按单数概念分深模块（agent、artifact、attachment、channel、cron、game、issue、
                           ledger、library、media、memory、mcp、orchestrator、pkm、provider、publish、repo、session、setting、tool、watch、workplace；
                           工单板拆成 issue（状态与交付）、session（帮工和每一轮）、workplace（worktree 与合并），都只经 ledger 写），lib.rs 组装 Hub，
                           start.rs 起服务，main.rs 读参数和环境；assets/ 是工具说明（tools/）、助手和帮工的提示
crates/vibevalley-http/    HTTP 门（/api/v1、SSE、/mcp）：照契约的接口表把请求交给服务端
crates/vibevalley-server-api/  服务端对页面和 HTTP 门的接口（Server trait）
crates/vibevalley-core/    核心状态与规则：reduce、frame、工单的状态和阶段、收件箱、巡查、农场的画面、简报和起草
crates/vibevalley-protocol/  契约的 Rust 类型：src/generated 由 gen/ 从 packages/protocol 的 zod 生成（vp run protocol:rust），不手改
crates/vibevalley-oar/     oar 的 Rust 实现：Claude Code、Codex、ACP 和测试用的 scripted 农机
crates/vibevalley-agent/   VibeValley 自己的 agent：模型请求（DeepSeek）、工具、对话循环和压缩
crates/vibevalley-cli/     命令行（二进制 vibevalley，clap）：照领域模型一条命令一个操作，经 HTTP 调服务端
crates/vibevalley-home/    家目录在磁盘上的约定：在哪、server.json、语言；服务端、命令行、原生应用共用
crates/vibevalley-i18n/    Rust 这边说的话：读 packages/i18n/locales 的词典，t("key")
crates/vibevalley-*        其余：store（SQLite）、git、files、terminal、workspace、memory、pkm、artifact、cron、bridge（页面和进程内服务端的桥）
apps/mac/                  原生应用（GPUI）：src/ 是窗口、终端、像素农场和宿主；ui/ 是 nsh 跑的 TSX 页面（vp run mac:check）
apps/web/                  页面（Solid 2 + Vite）：桌面和浏览器共用，由服务端（--web）在 / 提供；/farm 是像素农场（PixiJS）；
                           分层 base → infra → state → ui → features → 皮 → app，lint 查（apps/web/README.md）；等 apps/mac 覆盖它再删
apps/desktop/              Electron 壳：带着 Rust 的 vibevalley-server 起来，打开它提供的页面；等 apps/mac 能发版再删
apps/island/               刘海上的灵动岛（Swift）：桌面壳带起来的原生小程序（apps/island/README.md）
apps/mobile/               手机壳（Expo）：服务端那边的「连接到本机」已经砍掉，等后面的闸删
apps/site/                 官网 vibevalley.dev（Vite + Solid 2 静态生成），图和像素字用根目录 assets/ 的
assets/                    全部的图、像素字、指针和样音
packages/protocol/         契约（zod）：src/<概念>/{shapes,schema,api}.ts；Rust 类型由它生成，R5 以后反过来由 Rust 生成
packages/i18n/             对用户说的话：locales/<语言>/<宿主.模块>.json 的词典，TS 里 t("key")，Rust 里 vibevalley-i18n
packages/*                 页面、桌面版和生成器还在用的 TS 包：base-ui、engine、bridge、pkm、artifact、ai、provider、async、home、testkit、stories、
                           health、tsrs；各自的约定在它的 README
design/                    生图提示词、脚本和切图规则；原图在单独的仓库 vibevalley-art，design/art.sh 链接进来
docs/                      当前的行为和约定；subsystems/ 是各子系统从架构角度沉淀下来的样子（docs/AGENTS.md）
.agents/notes/             Agent Notes：具体的计划，做完沉淀进 docs/subsystems
.agents/skills/            仓库自己的 skill：验收（vv-acceptance）等；.claude/skills 链接到这里
scripts/                   gen/（生成物写出）、audit/（lint、语法树与棘轮门禁）、docs/（Note、链接、术语与旧名检查）、release/（打包、回归与验收沙箱 verify-server.ts）
```

## 命令

```bash
vp install                                                      # 根目录：装 TS 依赖（Vite+ 带的 pnpm 12）
cargo run -p vibevalley-server                                  # 服务端，127.0.0.1:8787；-- --web apps/web/dist 同时提供页面；VIBEVALLEY_HOME、VIBEVALLEY_WORK_ROOT、VIBEVALLEY_PORT 改位置
cargo run -p vibevalley-cli -- issue list                       # 命令行：issue、channel、repo、agent、session、runtime、memory、cron、artifact、pkm、worker、doctor
vp run rust:check                                               # 改完 crates/ 或 apps/mac：cargo fmt、clippy（-D warnings）、cargo test
vp run protocol:rust:check                                      # 改了 packages/protocol 的形状：重新生成 Rust 类型和 artifact、pkm 的 golden，和提交的不同就失败
vp run mac:check                                                # 改完 apps/mac/ui：nsh 的类型检查和打包（先 vp run nsh:install）
vp check                                                        # 改完任何 TS：格式（oxfmt）、lint（oxlint，带类型，跑在 tsrs 上）和类型；--fix 改格式
vp run packages:check                                           # 改完 packages/：打出声明、vp check、各包的测试
vp run web:check                                                # 改完 apps/web、apps/desktop、页面用的包：vp check、测试、页面构建
vp run --filter @vibevalley/web e2e                              # 页面全量自动检查，对着 Rust 服务端；定点用 e2e:component / e2e:integration（apps/web/README.md）
vp run desktop:test                                             # 改完 apps/desktop：Playwright 起整个 Electron 应用（带 Rust 服务端）
vp run practice:check                                           # 语法树实践棘轮（scripts/audit/practice-audit.ts，变少了跑 practice:write）
vp run health:verify                                            # 热点和逃生口的棘轮（vp run health 看报告，变少了跑 health:write）
vp run docs:verify                                              # 改完文档、Note 或 skill：格式、目录、链接、旧名字、用语、词典和生成的参考表
vp run notes:catalog                                            # 加、挪、删 Note 或改了标题：重写 .agents/notes/CATALOG.md
vp run i18n:gen                                                 # 改了 packages/i18n/locales：重写 catalogs.ts；vpx scripts/gen/i18n.ts check|find <文字> 查问题、找键
vp run capabilities                                             # 改了 <概念>/api.ts 的 can：重写 docs/reference/capabilities.md
vp run api:client                                               # 改了 <概念>/api.ts 的接口：重写 packages/protocol/src/client.ts
vp run deadcode                                                 # knip 查 TS 里没人用的文件、导出和依赖
vp run release alpha|beta|final                                 # 发版：算版本、跑 release:verify，问过才打 tag 推送（docs/development.md）
```

Rust 照 `rust-toolchain.toml`，Node 24（`.node-version`），Vite+（`vp`：pnpm 12、格式、lint、类型、测试、任务）。先跑和改动有关的最窄的检查。服务端不自动重载：改了 `crates/` 要重新构建、重启它。

一件事的主线：oar 的会话事件 → 服务端读成事实 → `vibevalley-core` 的 `reduce` 折进核心状态 → `GET /api/v1/state` 把折好的 `StateFrame` 经 SSE 推给页面；会话和助手的每一步记成轨迹（[architecture.md](docs/architecture.md)、[子系统](docs/subsystems/README.md)）。

## 怎么让 agent 做对

agent 照着已有的代码抄，走最短的路，所以要让容易的写法就是对的写法。挡住一类问题，按下面的顺序选手段，能用前面的就不用后面的（[理由](docs/subsystems/process.md)）：

1. **代码（类型与静态结构）**：清楚的模块边界、结构体和 enum 表达的不变量、进门一次解码；让非法状态不可编译，把一类问题整个消掉（[静态化、类型化与可分析化](docs/style/module-design.md)）。
2. **静态检查**：Rust 的类型、clippy（`-D warnings`）和测试；TS 一侧是严格的 TypeScript（tsrs）、带类型的 oxlint 与语法树棘轮（`practice:check`、`health:verify`）；失败时写清错在哪、怎么改、看哪个文件（[写法](docs/style/code.md)）。
3. **文字**：注释、规矩、本文、skill，只写没法强制、要 agent 自己判断的；只有跑起来才看得出对不对的，写成验证 skill（[.agents/skills](.agents/skills/README.md)，照 [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) 写）。
4. **人看**：最难扩展；人的精力花在设计让 agent 默认就做对的环境上。

一条新规矩，先问能不能写成类型、clippy 规则或测试；只有写不成的，才进下面的列表。

## 规矩

- **Rust 为准，速度优先**：服务端的行为以 Rust 为准；照搬 TS 成本高、价值低的就砍掉或简化，记进[原生计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)的「砍掉的」。
- **先有概念，再有皮**：服务端按实际概念分模块（[概念](docs/concepts.md)）；农场只画它们，游戏规则只读事件算画面，业务不调它（[农场的皮](docs/subsystems/farm.md)）。
- **核心状态只有一份**：帮工或农场的新状态加进契约的形状与事实，在 `vibevalley-core` 的 `reduce` 里折叠，只经事实施加，不在服务端或页面另存一份（[核心状态](docs/subsystems/core.md)）。
- **边界解码一次，门内全是类型**：HTTP、文件、厂商响应、模型给的工具参数，各在进门处用 serde 解码成结构体和 enum；门内不传 `serde_json::Value`、不按字符串分支；钥匙包进 `Secret`（打印只出提示）（[类型驱动与进门解码](docs/style/module-design.md)）。
- **深模块**：每个模块对外一个窄接口；不靠一个带 `kind` 的入口复用多种操作（[模块设计](docs/style/module-design.md)）。
- **封闭的联合穷尽处理**：Rust 的 `match` 不写吞掉新成员的 `_`；TS 按 `_tag`、`kind`、`type` 分支时 `switch` 覆盖全部成员（`switch-exhaustiveness-check` 查）。
- **生成的不手改**：`crates/vibevalley-protocol/src/generated`（`protocol:rust`）、`packages/protocol/src/client.ts`（`api:client`）、`packages/i18n/src/catalogs.ts`（`i18n:gen`）与生成的参考表由脚本写出，`protocol:rust:check` 和 `docs:verify` 查是不是最新。
- **内部不留兼容**：改名、改形状、改落盘格式直接改，不写兼容层、旧数据兜底或迁移脚本；对外 HTTP `v1` 是唯一例外（[接口版本](docs/subsystems/core.md)）。
- **页面不折事实**：页面只读 `GET /api/v1/state` 推来的 `StateFrame` 并写画面摆法；缺数据就补进契约与 `reduce` 或调接口问服务端（[客户端](docs/subsystems/app.md)）。
- **处理函数要薄**：HTTP 门和页面组件只做转发与展示，规则留在所属模块或纯函数里（[架构](docs/architecture.md)）。
- **帮工没有权限确认**：服务端只听 `127.0.0.1`，帮工只在工作目录开工（[帮工](docs/subsystems/session.md)）。
- **包之间只经包名**：TS 跨包只经 `package.json` 的 `exports` 写 `@vibevalley/*`（`no-cross-package-path` 查）；Rust 跨 crate 只经 `Cargo.toml` 的依赖。
- **图标分两套**：工作台用注册的 reicon 线条图标，像素皮与头像、农机 logo 用 `design/pixel` 生成的像素图，都不用字符符号代替（[图标](docs/style/design.md#图标)）。
- **界面照田间工作台**：颜色、圆角、字号、阴影、动效和层级一律走令牌（页面是 `apps/web/src/style.css`，原生是 `apps/mac/ui/tokens.ts` 与 `apps/mac/src/theme.rs`）；照 [界面怎么做](docs/style/design.md)，Tailwind 写法照 [vv-tailwind](.agents/skills/vv-tailwind/SKILL.md)。
- **密钥**：家目录的 `settings.json` 不进仓库；日志、快照和文档里不出现真实密钥。
- **话放在哪**：对用户的话进 `packages/i18n/locales/{zh,en}/<宿主.模块>.json`，Rust 调 `vibevalley_i18n::t`，TS 调 `t("key")`（`vpx scripts/gen/i18n.ts check` 查漏翻）；对模型的话用中文写进 `crates/vibevalley-server/assets`（[话放在哪](docs/subsystems/foundation.md)）。
- **代码风格**：代码和接口用实际业务概念，种地双关只留在农场的皮里（`stale-names.ts` 查，[用语表](docs/README.md#用语)）；命名站在领域视角说管什么事，不用 `utils`、`state` 一类泛词（[命名](docs/style/naming.md)）；英文注释只写不看就会改错的约束与原因（[代码风格](docs/style/code.md)）。
- **测试**：行为在能发现出错的最低层测；服务端的测试在 `crates/*/tests`，用 scripted 农机与真 git 离线跑；不写硬编码睡眠等待；页面 Playwright 对着隔离的 Rust 服务端、只按 `data-testid` 找元素（`no-copy-selector` 查）；修缺陷补 `regression` 测试。
- **改完要验证**：先跑最窄的静态与单元检查；改了接口、服务或页面，照 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 在真实程序上验收并附上证据。
- **分支、提交和 PR**：同批改动默认合一个 PR，只经 squash 合入 `main`；分支 `<类>/<主题>`，提交与 PR 用英文写改完后的行为（标题不超过 100 字符、不带 agent 署名，commit-msg hook 与 CI 查），操作照 [vv-pr](.agents/skills/vv-pr/SKILL.md)（[分支、提交和 PR](docs/development.md)）。
- **文档和 Note**：改行为同改对应文档（优先改 `docs/subsystems/`，见 [文档规矩](docs/AGENTS.md)）；非平凡改动先写 `proposed/` Note，上线后把长期成立的沉淀进子系统并删掉 Note（[什么时候写](.agents/notes/README.md#什么时候写)）。

## 编辑本文

`CLAUDE.md` 只有一行 `@AGENTS.md`，引用本文；规矩都改在本文。每条规矩自成一句，细节链接到它的家。
