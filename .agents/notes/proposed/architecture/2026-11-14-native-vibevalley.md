# Agent Note: 原生的 VibeValley：照着 TypeScript 版一次重写成 Rust 和原生 macOS 应用

Status: proposed

## Problem

VibeValley 现在是 Node 服务端（`apps/server`，不含测试约 4.6 万行）+ Solid 页面（`apps/web`，6.1 万行）+ Electron 壳（`apps/desktop`）+ Expo 手机壳（`apps/mobile`）。用户在单独的仓库 `~/epona`（183 个提交，最终提交 `fbc43d4`，工作区干净）里已经把它原生改写了大半，基线是本仓库的 `2649ec3f7`：

- **服务端**：Rust，进程内一个 `Server`（`call(op, payload) → Envelope`、`state`、`live`、`subscribe`），另有可选的回环 HTTP。线上格式和 `packages/protocol` 逐字节一致（598 个类型、202 个操作由 zod Schema 生成，golden 覆盖），`reduce`、`effectsOf`、`frameOf` 用本仓库写出的 98 条事实做 golden。存储是 SQLite。
- **编码 agent 驱动**：Rust 版 oar（Claude Code、Codex、ACP）和自带的 agent 循环（相当于 pi-durable 加 `packages/agent`）。
- **界面**：GPUI 原生窗口；`apps/web` 的页面移植成 nsh TSX（6.8 万行），农场、地图、树、开场、图鉴由 GPU 直接画。
- **新功能**：终端（libghostty-vt）、文件树和只读预览、git 状态与 diff、多项目。

这篇 Note 的上一版分五个 PR 渐进迁移：迁入、追上 `main`、补齐服务端并删 TS 服务端、补齐界面、删页面，每段之间一道闸。它的成本在并存期：

- 第 2 到第 5 段之间 TS 和 Rust 两个服务端并存，改一次契约或行为要改两遍；golden 只查契约和 projection，查不到模块里的行为。
- 两道闸（`apps/web` 的 Playwright 全部跑在 Rust 服务端上；每个路由两种主题、几种宽度对图）要求 Rust 侧逐项追平 TS 侧，包括用户已经不要的手机壳、浏览器和连接器。
- TS 侧的全部检查（`server:check`、`web:check`、`practice:check`、`paths:check`、`health:verify`、`deadcode`）在并存期都要保持通过，尽管这些代码马上要删。

用户的决定（2026-11-14）：不走渐进迁移，照着 TS 版直接重写；只做 macOS；越快越好；最后结果对上就行，接受回退，不要求完整复刻 oar 和 pi-ai。

## Proposal

一个分支（`refactor/native`）、一个 PR、一次 squash。分支的第一批提交就删掉 TS 的服务端、页面和两个壳；从那以后 TS 版只是参照物（标签 `ts-final`，用 `git show ts-final:<路径>` 或一个只读的 worktree 读），不再编译、不再跑检查、不追同步。`main` 在 PR 合入前一直是能用的 TS 版，只收修复。

### 定下来的

| 事项 | 决定 |
| --- | --- |
| 平台 | 只有 macOS。删掉 `apps/web`（浏览器）、`apps/mobile`、`apps/desktop`、`lan` |
| 迁移方式 | 不并存。分支上先删 TS，再补 Rust；没有段间的闸，只有合入前的一次验收 |
| 契约的源头 | Rust。`vibevalley-protocol` 的类型是手写的源头，页面用的 TS 类型由它生成 |
| 命令行 | Rust（`crates/vibevalley-cli`，二进制 `vibevalley`）。删掉 TS 的 `apps/cli` |
| 存储 | SQLite，单机。不做 Postgres |
| 旧数据 | 不迁。照「内部不留兼容」，新应用启动时把旧家目录归档，从空开始 |
| 与 TS 版的偏差 | 不逐条追平。只修挡住[主线](#对上指什么)的；其余写进子系统文档，成为新行为 |
| TS 的测试 | 不移植。Rust 侧只写主线和纯规则的测试 |

### 终态

```
crates/                  Rust 库，一个 Cargo workspace（根 Cargo.toml），名字 vibevalley-<概念>
apps/mac/                原生 macOS 应用：Rust 二进制 VibeValley（GPUI）+ ui/（nsh TSX 的工作台页面）
apps/island/             灵动岛（Swift），由 apps/mac 带起
apps/site/               官网
assets/                  原 apps/web/public：像素图、像素字、指针、样音，app 和官网共用
packages/                只剩页面用的 TS：pkm、artifact 的编辑器状态机，和由 Rust 生成的 protocol 类型、词典键
```

没有 Node 运行时；`vp` 只管 `apps/mac/ui`、`apps/site`、`packages/` 和 `scripts/`。

crate 照本仓库的概念命名，`epona` 这个词在代码、环境变量、路径、文档里一个不留（加进 `scripts/docs/stale-names.ts`）：

| epona | VibeValley | 说明 |
| --- | --- | --- |
| `epona-protocol` + `epona-server-api` | `vibevalley-protocol` | 线上类型和 `Server` trait；从生成物变成源头 |
| `epona-flow` | `vibevalley-core` | reduce、effectsOf、frameOf、规则 |
| `epona-server` + `epona-issues` | `vibevalley-server` | 模块照[正交领域](.agents/notes/proposed/architecture/2026-11-12-orthogonal-domains-and-event-watch.md)的边界分；「board」不是本仓库的概念，拆进 issue、session |
| `epona-http` | `vibevalley-http` | 回环的 `/api/v1`、SSE、附件、artifact 页，和帮工用的 `/mcp` |
| `epona-agents`（含 `roar`） | `vibevalley-oar` | Rust 版 oar |
| `epona-brain` | `vibevalley-agent` | 自研 agent 的循环、压缩和工具 |
| `epona-cron`、`epona-memory`、`epona-pkm`、`epona-artifact`、`epona-i18n`、`epona-git`、`epona-files` | `vibevalley-<同名>` | |
| `epona-term` | `vibevalley-terminal` | |
| `epona-store`、`epona-workspace` | `vibevalley-store`、`vibevalley-workspace` | app 侧：项目、布局、存下的终端 |
| `epona-bridge` | `vibevalley-bridge` | 页面和 `Server` 之间的桥 |
| `epona-app` | `apps/mac`（crate `vibevalley-mac`） | |
| （无） | `vibevalley-cli` | 新写，经回环 HTTP 调服务端 |

环境变量 `EPONA_*` 改为 `VIBEVALLEY_*`；家目录的位置、`server.json`、`settings.json` 照 `packages/home` 现在的约定，在 Rust 里重写，`packages/home` 删掉。

### 对上指什么

「对上」是合入前在 `apps/mac` 的真包上走通下面的清单，不是和 TS 版逐行为一致。

**主线（一条不能少）**：从空的家目录起，

1. 走完开场，配好一台农机（Claude Code 或 Codex）和助手的模型。
2. 建一个仓库，建一张工单，派给一个档案。
3. 帮工在工单的 worktree 里干活；工单页看得到每一轮的轨迹；帮工经 `/mcp` 在工单串里汇报。
4. 用户在工单串里追问，帮工接着干；用户看改动，合进主分支。
5. 在田头对助手说一句话，助手建工单并派出去。
6. 定时任务到点建一张工单。
7. 命令行 `vibevalley doctor`、`issue list`、`issue create`、`channel` 发一句话，对着运行中的应用通过。
8. 退出再打开，在做的工单、会话和聊天都接得上。

**页面**：TS 版的每个工作台路由在 `apps/mac` 有对应页，两种主题各截一张；农场能进、能看见帮工在地上干活。不要求和 TS 版像素一致。

**冻结的 golden**：从 `ts-final` 最后生成一次的线上 JSON 和 projection golden 留作 Rust 的测试夹具。之后有意改契约就改夹具，不再回头对 TS。

### 首版不做的

合入时这些功能没有；每条在对应的子系统文档里记一句「原生版还没有」，以后要做另写 Note。

| 砍掉的 | TS 版在哪 | 为什么可以砍 |
| --- | --- | --- |
| 手机壳、「连接到本机」 | `apps/mobile`、`gateway/lan` | 只做 macOS |
| 浏览器里打开工作台 | `apps/web` 由服务端在 `/` 提供 | 只做 macOS；页面只留 nsh 一份 |
| 连接器（微信、飞书、QQ） | `gateway/connector` | 不在主线上 |
| 通话和实时字幕（声网、MOSS 会话） | `gateway/voice`、`packages/ai`、`packages/provider` | 不在主线上；连带砍掉全局语音快捷键和拨号页 |
| media 的语音、音频、理解（27 个操作里的 14 个） | `modules/media` | 图片已有；其余不在主线上 |
| 记性的外部源 | `modules/memory` | 本地源已有 |
| 外部 Postgres、多机 | `database.url`、[服务端和机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md) | 单机 SQLite。那篇 Note 随本 PR 删掉，多机以后在 Rust 上重新提 |
| 助手的评测 | `evals`、`orchestrator.eval.create` | 助手的循环换了，样例要重录 |
| 从 Electron 版自动更新到原生版 | `apps/desktop/src/infra/update.ts` | 两个包不是一个应用；旧版用户重新下载 |
| 零件的故事 | `packages/stories` | nsh 页面用 `shot:` 截图代替 |

助手的工具（pkm、素材库、artifact、`search_archive`、`resource_read`）、巡查和收件箱轮次不砍：助手是主线的一环，缺工具的助手会在田头答错。

### 做法

一个分支上按下面的次序提交。第 1 到第 3 步由一个 agent 串行做（它们改同一批文件）；第 4 步按路径分给几个 agent 并行；第 5 步合起来验。

1. **冻结 TS**。把正交领域的工作区改动提交、合进 `main`，打标签 `ts-final`。从这里起 `main` 只收修复。
2. **迁入、改名、删除**。
   - 照上表拷贝 `fbc43d4` 的 crates 并改名，`ui/` 放到 `apps/mac/ui`。
   - 同一批提交里删掉 `apps/server`、`apps/web`、`apps/desktop`、`apps/mobile`、`apps/cli`，和 `packages/` 里的 `agent`、`ai`、`provider`、`engine`、`base-ui`、`stories`、`bridge`、`home`、`testkit`、`health`、`async`、`tsrs`（最后一个若 `vp check` 还要就留）。
   - `apps/mac/ui` 里从本仓库拷来的文件（`vv/pkg`、`vv/web`）换成真文件：页面还用的 `apps/web/src` 文件 `git mv` 到 `apps/mac/ui`，`pkm`、`artifact` 经 workspace 包名引用。`apps/web/public` 移到 `assets/`，删掉 `fetch-vv.sh`、`sync*.sh`。
   - 工具链：`rust-toolchain.toml`（1.99）、Zig 0.17.1（构建 libghostty-vt 要用）、根 `.gitignore` 加 `target*/`。
3. **最后生成一次，翻转源头**。
   - 对 `ts-final` 跑一次 epona 的生成器（它读 `git archive` 的拷贝，不需要工作区里有 TS）：Rust 类型、golden、助手的提示和工具描述。改到 `cargo test --workspace` 通过；`epona-issues` 照正交领域的边界拆进 `vibevalley-server`。
   - 删掉生成器（`gen.ts`、`golden.ts`、`prepare.sh`）。Rust 类型从此手写；golden 留作夹具。
   - 加 `vp run protocol:ts`：由 Rust 类型写出 `packages/protocol` 的 TS 类型和操作表，页面只用它。词典（`locales/`）和提示移到各自的 crate，词典键的 TS 类型由 `i18n:gen` 从 Rust 侧的词典写出。`packages/protocol/src/rules` 里页面还用的纯函数留在 `apps/mac/ui`，其余删掉。
4. **并行补齐**。每个 agent 只改自己的路径；要改 `vibevalley-protocol` 的，交给服务端那个 agent 改。

   | 工作 | 路径 | 做到哪算完 |
   | --- | --- | --- |
   | 服务端 | `crates/vibevalley-{server,core,protocol,http,oar,agent}` | `/mcp`；助手剩下的工具、巡查和收件箱轮次、进行中注入；挡住主线的偏差（每仓库串行锁、`.vibevalley/setup`、评论经工单串、`session.list` 含已结束的会话、定时任务的触发类型）；一个用脚本化农机走完主线第 2 到第 6 步的集成测试 |
   | 命令行 | `crates/vibevalley-cli` | `issue`、`channel`、`auth`、`doctor`、`pkm`、`app`、`chat` 各命令；主线第 7 步 |
   | 页面 | `apps/mac/ui` | 助手的记性页、工单里的 artifact、素材库、看板拖动、快捷键表；每个路由两种主题截图 |
   | 农场 | `crates/vibevalley-mac` 的农场部分 | 工具栏、面板、田头聊天、帮工外观；夜间遮罩和树 HUD 两个缺陷 |
   | 宿主和打包 | `crates/vibevalley-mac` 的其余、`apps/island`、`scripts/release` | 菜单栏图标、开场、安装命令行、带起灵动岛、自动更新、签名公证、`.dmg`/`.zip`/`release.json`；`package:mac`、`release`、`update-check` 走 Rust 的包 |
   | 检查和文档 | 根配置、`scripts/`、`docs/`、`AGENTS.md`、`.agents/skills` | 见[检查换成什么](#检查换成什么)；`AGENTS.md`、`docs/architecture.md`、`docs/subsystems/*`、`vv-acceptance` 写成 Rust 和原生的现状 |

5. **验收，合入**。在签名的包上走完[对上指什么](#对上指什么)的清单，截图和命令输出附在 PR 的 Checks 里；squash 合进 `main`。`ts-final` 标签留着。

**停下的条件**：第 3 步做完后，主线第 1 到第 4 步在 `apps/mac` 上走不通，并且原因在 nsh、gpui-kit 或 libghostty-vt 里而不在本仓库的代码里，就停下来报告用户，不绕过去。

### 检查换成什么

TS 侧的护栏随 TS 代码一起删。Rust 侧从第 2 步起就有下面这一组，放进 `vp run rust:check`，CI 加一个带缓存的 macOS job：

| TS 版 | 原生版 |
| --- | --- |
| `vp check`（格式、带类型的 lint、类型） | Rust：`cargo fmt --check`、`cargo clippy --workspace --all-targets -- -D warnings`；`apps/mac/ui`、`apps/site` 仍是 `vp check` |
| `server:check` 的 vitest | `cargo test --workspace`：golden 夹具、规则的单元测试、脚本化农机的主线集成测试 |
| `modules.test.ts`、`paths:check`（模块的单向依赖） | `vibevalley-server` 里一个测试：扫各模块的 `use crate::modules::…`，对着一张允许表；`Channel` 不 `use` 业务模块，`Session` 不 `use` `Channel`、`Issue` |
| Zod 进门解码、`schema-audit.ts` | serde 类型在边界解码；受约束的值用 newtype，构造函数里查范围。不设审计脚本 |
| `db:generate`、`schema.test.ts` | SQL 留在各模块；一个测试查表名是「模块_概念」、索引以表名开头 |
| `protocol-surface.ts`、`api:client`、`capabilities` | `protocol:ts` 的生成物是否最新，由 `rust:check` 查 |
| `no-cjk-literal`、`i18n.ts check` | 一个测试：`.rs` 里的中文只出现在 `prompts.rs`；词典两种语言的键一致 |
| `no-wall-clock`、`no-test-sleep` | `clippy.toml` 的 `disallowed-methods`：`SystemTime::now`、`Instant::now`、`thread::sleep` 只许在时钟的实现里 |
| `practice:check`、`health:verify`、`deadcode` | Rust 侧不设；未使用的代码由 `-D warnings` 报。`deadcode`（knip）只查剩下的 TS |
| Playwright 的 e2e、`desktop:test` | `apps/mac` 的 `shot:`、`hosted:`、`key:`、`mouse:` 调试脚本，照改写后的 `vv-acceptance` 跑 |

## Alternatives considered

**分五个 PR 渐进迁移（本 Note 的上一版）**：每段合入时 `main` 都能用，代价是 Problem 里列的并存期。用户选了速度，接受分支期间没有中间的可用状态；`main` 上的 TS 版在合入前一直能用，起的是同样的兜底作用。

**多留 `apps/web` 一阵，等原生界面日用稳定再删**：Rust 服务端经 HTTP 提供旧页面，原生界面出问题时有退路。但那样 Rust 服务端要一直答旧页面要的每个操作（包括连接器、通话、手机配对的页面），「首版不做的」一条都砍不掉。退路改成 `ts-final` 标签和上一个 Electron 包。

**zod 仍是契约源头，Rust 类型一直由它生成**：生成器现成。但服务端、命令行都成了 Rust，TS 只剩页面；源头留在 TS 等于让 Rust 的每次改动先去改一个不跑它的语言，生成器表达不了的东西（无判别字段的联合、`refine`、数字的整型与否，见 epona 的 `gen/report.txt`）也要一直手工对。

**逐条修掉 epona 记下的约 20 条偏差再合**：多数是没人会碰到的差别（并列排序用字节序而不是 `localeCompare`、损坏的 `settings.json` 怎么改名）。只修挡住主线的五条，其余当新行为写进文档。

**把 TS 的 960 个服务端测试移植成 Rust**：它们按 TS 的模块接口写，Rust 的接口不同，移植等于重写一遍。主线的集成测试加冻结的 golden 能发现主线上的错；别处的错留给使用中发现，这是用户接受的回退。

**不迁仓库，把 epona 改名当作新的 VibeValley**：省掉搬家。但文档、Note、设计规则、官网、灵动岛、发版脚本和提交历史都在本仓库，搬它们比搬 crates 更费事。

**用 git subtree 带进 epona 的历史**：本仓库只用 squash 合入 `main`，历史反正压成一个提交；记下最终提交号 `fbc43d4` 就够追溯。

## Acceptance criteria

- 仓库里没有 `apps/server`、`apps/web`、`apps/desktop`、`apps/mobile`、`apps/cli`，没有 Electron、Expo、PixiJS、Hono、oar、pi-durable 依赖；`epona` 这个词不出现（`stale-names.ts` 查）。
- `vp run rust:check`、`vp check`、`vp run docs:verify`、`vp run deadcode` 通过。
- 契约的源头是 `vibevalley-protocol`：改了 Rust 类型而没重新生成 TS，`rust:check` 失败。
- [对上指什么](#对上指什么)的主线八条在签名公证过的 `apps/mac` 包上从空家目录走通，页面的截图齐全，证据附在 PR 的 Checks 里。
- 在两个真包上走一遍原生版到原生版的自动更新。
- 「首版不做的」每一条在对应的子系统文档里有一句记录；`AGENTS.md`、`docs/architecture.md`、`docs/subsystems/*` 写的是 Rust 和原生的现状。
- [服务端和机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md) 和[正交领域](.agents/notes/proposed/architecture/2026-11-12-orthogonal-domains-and-event-watch.md) 两篇 Note 已删（后一篇长期成立的部分沉淀进 `docs/subsystems`）；长期成立的部分沉淀后删掉本 Note。

## Risks

- **分支期间没有能用的中间状态**：第 2 步删掉 TS 以后，分支上的应用要到第 4 步的服务端和宿主都补齐才能日用。兜底是 `main` 和上一个 Electron 包；分支拖得越久，`main` 上的修复越要手工对到 Rust。
- **行为的保障变薄**：TS 服务端 960 个测试，Rust 的 server、flow、issues、agents、brain 五个 crate 共 218 个。主线以外的错要到使用中才发现。
- **nsh、gpui-kit、libghostty-vt 的成熟度**：三个都是 0.x（nsh 0.5、gpui-kit 0.9，libghostty-vt 钉在一个 git 提交上）。nsh 能否从 workspace 包和别名解析 import，第 2 步要先验证；不行就在 nsh 的解析配置里补，不回到复制文件。挡住主线时照「停下的条件」。
- **已发版的用户**：升级后看不到旧工单和聊天，Electron 版也不会自动更新到原生版。发版说明里要写明，并保留上一个 Electron 包的下载。
- **砍掉的功能里有人在用的**：通话和连接器是已发版的功能，砍掉是看得见的回退。合入前由用户再过一遍「首版不做的」。
- **护栏变少后 agent 写错的更多**：这个仓库靠静态检查让 agent 默认写对，Rust 侧合入时只有上表那一组。`practice:check` 这类棘轮以后按实际出的问题一条条加，不预先照搬。
