# Agent Note: 原生的 VibeValley：把 epona 的 Rust 改写迁进来，去掉 Electron、TS 服务端、页面和手机壳

Status: proposed

## Problem

VibeValley 现在是 Node 服务端（`apps/server`）+ Solid 页面（`apps/web`）+ Electron 壳（`apps/desktop`）+ Expo 手机壳（`apps/mobile`）。用户在单独的仓库 `~/epona`（182 个提交，冻结于 2026-11-14）里已经把它原生改写了大半，基线是本仓库的 `2649ec3f7`：

- **服务端**：Rust，进程内一个 `Server`（`call(op, payload) → Envelope`、`state`、`live`、`subscribe`），另有可选的回环 HTTP。线上格式和 `packages/protocol` 逐字节一致：类型由 zod Schema 生成（598 个类型、202 个操作），golden 测试覆盖。`reduce`/`effectsOf`/`frameOf` 用本仓库写出的 98 条事实做 golden。issue、session、watch、repo、agent、setting、provider、channel、memory、orchestrator（DeepSeek）、cron、game、pkm、artifact、library 都已提供；本仓库未改动的 `apps/cli`（`doctor` 等）对着它跑通。存储用 SQLite。
- **编码 agent 驱动**：Rust 版 oar（Claude Code、Codex、ACP），自带 agent 循环（相当于 pi-durable 加 `packages/agent`）。
- **界面**：GPUI 原生窗口。`apps/web` 的页面逐行移植成 nsh TSX（Solid 式的响应式，跑在 nsh 的 JS 引擎里），由宿主经桥接到 `Server`。农场、地图、树、开场、图鉴由 GPU 直接画，美术沿用 `apps/web/public`。
- **epona 自己加的**：终端（libghostty-vt）、文件树和只读预览、git 状态与 diff、多项目。凡是出现工作目录、仓库、会话、工单的地方都能「在这里开终端」。

两边分着长：epona 靠 `git archive 2649ec3f7` 拷贝本仓库的 protocol、i18n、pkm、artifact 和页面文件（`ui/vv/sync*.sh`、`fetch-vv.sh`），本仓库每改一次契约，Rust 侧都要手工追一批，而且没有检查告诉它漏了什么。

用户的决定（2026-11-14）：epona 整个迁进本仓库，名字统一叫 VibeValley；终态全原生，删掉 `apps/desktop`、`apps/server`、`apps/web`、`apps/mobile`；先合掉 [正交领域](.agents/notes/proposed/architecture/2026-11-12-orthogonal-domains-and-event-watch.md) 的重构再迁。

## Proposal

### 终态

```
crates/                  Rust 库，一个 Cargo workspace（根 Cargo.toml），名字 vibevalley-<概念>
apps/mac/                原生 macOS 应用：Rust 二进制 VibeValley（GPUI）+ ui/（nsh TSX 的工作台页面）
apps/cli/                命令行（仍是 TypeScript，经 HTTP 调 Rust 服务端）
apps/island/             灵动岛（Swift），由 apps/mac 带起
apps/site/               官网
packages/protocol        仍是契约的唯一源头：zod Schema 生成 Rust 类型；nsh 页面和 CLI 直接用 TS
packages/i18n            词典：Rust（服务端、shared）和 nsh 页面共用同一份 locales
packages/pkm、artifact   页面侧的编辑器状态机（TS）；服务端侧是 crates 里的 Rust 实现，两边由 golden 对齐
assets/                  原 apps/web/public：像素图、像素字、指针、样音，app 和官网共用
```

只剩一个服务端，就是 Rust 的；不再有 Node 运行时（CLI 和脚本仍走 `vpx`）。不迁 epona 的「终端优先工作台」定位：终端、文件、git 是 VibeValley 的新功能，挂在工单、会话、仓库上。

### 改名

`epona` 这个词在代码、环境变量、路径、文档里一个不留（加进 `scripts/docs/stale-names.ts`）。crate 照本仓库的概念命名：

| epona | VibeValley | 说明 |
| --- | --- | --- |
| `epona-protocol` | `vibevalley-protocol` | 生成的线上类型、信封、BizCode |
| `epona-server-api` | `vibevalley-server-api` | `Server` trait：桥和 HTTP 经它找服务端（不依赖服务端本身） |
| `epona-flow` | `vibevalley-core` | reduce、effectsOf、frameOf、双端规则 |
| `epona-server` | `vibevalley-server` | 按 `apps/server/src/modules` 分模块 |
| `epona-issues` | `vibevalley-issues`，第 2 段并入 `vibevalley-server` 的 issue、session 模块 | 「board」不是本仓库的概念；照正交领域的边界拆进去 |
| `epona-http` | `vibevalley-http` | 对外的门：`/api/v1`、SSE、附件、artifact 页 |
| `epona-agents`（含 `roar`） | `vibevalley-oar` | Rust 版 oar |
| `epona-brain` | `vibevalley-agent` | 自研 agent 的循环、压缩和工具（原 pi-durable + `packages/agent`） |
| `epona-cron`、`epona-memory`、`epona-pkm`、`epona-artifact`、`epona-i18n`、`epona-git`、`epona-files` | `vibevalley-<同名>` | |
| `epona-term` | `vibevalley-terminal` | |
| `epona-store`、`epona-workspace` | `vibevalley-store`、`vibevalley-workspace` | app 侧：项目、布局、存下的终端 |
| `epona-bridge` | `vibevalley-bridge` | 页面和 `Server` 之间的桥（对应 `packages/bridge` 的角色） |
| `epona-app` | `apps/mac`（crate `vibevalley-mac`） | |

环境变量 `EPONA_*` 改为 `VIBEVALLEY_*`；家目录照 `packages/home` 的约定（位置、`server.json`、`settings.json`），不另起一个 epona 家目录。

### 分段（一个 PR，每段一组提交；每道闸过了才进下一段）

**0. 准备**
- [正交领域](.agents/notes/proposed/architecture/2026-11-12-orthogonal-domains-and-event-watch.md) 合进 `main`。
- epona 停止开发：把未提交的约 30 个文件在 epona 里提交，记下最终提交号，作为迁入来源。

**1. 迁入**：只搬家和改名，不改行为，Electron 照常能用。
- 照上表拷贝 crates，`ui/` 放到 `apps/mac/ui`。epona 的 `docs/handoff/*` 是工作日志，不搬：其中仍成立的「与 VibeValley 的偏差」和「缺口」并进本 Note 的第 3、4 段清单；`docs/design/components.md` 并进 `docs/style/design.md`。
- 去掉所有拷贝：生成器（`vibevalley-protocol/gen`、orchestrator 的提示和工具描述）直接读仓库里的 `packages/protocol`、`apps/server`；`apps/mac/ui` 经 workspace 包名引用 `packages/protocol`、`i18n`、`pkm`、`artifact`，不再有 `vv/pkg`；从 `apps/web` 复制来的纯文件（`vv/web/VENDORED` 列的那些）归 `apps/mac/ui` 所有，不再同步，因为 `apps/web` 在第 5 段删除；`apps/web/public` 现在就移到根目录 `assets/`（页面、官网和 app 共用），删掉 `fetch-vv.sh`。nsh 不打包 app 目录以外的媒体文件，所以试听样音移到 `apps/mac/ui/assets/voice-samples`。
- 工具链：`rust-toolchain.toml`（1.99）、Zig 0.17.1（libghostty-vt 构建要用）、根 `.gitignore` 加 `target*/`。`vp run rust:check`（`cargo fmt --check`、`clippy -D warnings`、`cargo test --workspace`）；`vp run protocol:rust` 重新生成，`server:check` 检查生成物是否最新；CI 加一个 macOS 的 Rust job（带缓存）。
- 验收：`rust:check` 通过；Rust 服务端在隔离的家目录上起来，`apps/cli` 的 `doctor` 和 issue、channel、pkm、artifact 命令跑通；`apps/mac` 起来，用 `shot:` 截工单看板和农场。

**2. 追上本仓库**：从 `2649ec3f7` 追到 `main`（含正交领域）。重新生成 protocol，用 `apps/server` 重写 projection golden，失败的逐个改；`epona-issues` 照新的 issue、session、watch 边界拆进 `vibevalley-server`。从这里起，**改 `packages/protocol` 或 `apps/server` 行为的 PR 要同时改 Rust**，`server:check` 的 golden 会拦。

**3. 服务端补齐，删掉 TS 服务端**
- 补齐：帮工用的 `/mcp`（帮工经 MCP 调 VibeValley 工具，现在没有）；media 剩下的部分（speech、audio、understanding，共 27 个操作）；助手剩下的工具（pkm、library、artifact、media、`search_archive`、`resource_read`）、巡查和收件箱轮次、进行中注入、`orchestrator.eval.create`；memory 的外部源；voice（声网）；connector（微信、飞书、QQ）；用户和设备里桌面仍要的部分。
- epona 记下的约 20 条偏差逐条处理：要么改成和 VibeValley 一样，要么作为新行为写进 `docs/subsystems`。例如 comment 直接投给会话而不经工单串、`session.list` 不含已结束的会话、`issue.status.update` 不能改派已发出的工单、cron 触发的轮次 trigger 记错类型、没有每仓库串行锁和 `.vibevalley/setup`。
- 存储：SQLite 的表照「模块_概念」命名，SQL 照表放；`db/queries` + 生成的做法换成 Rust 的等价物（如 sqlx 的编译期检查）。
- 闸：`apps/web` 的 Playwright e2e 全部跑在 Rust 服务端（`vibevalley-http` 提供页面）上并通过；`apps/cli` 的测试改成起 Rust 服务端并通过；照 vv-acceptance 在真程序上验收。过闸后，Electron 改为带 Rust 服务端；删掉 `apps/server`，以及只有它用的 `packages/agent`、`packages/ai`、`packages/provider`。

**4. 原生界面补齐**
- 页面：素材库与生成面板、笔记的拖动和雷达跳转、快捷键表；手机壳和语音相关的页面（拨号、实时字幕）。
- 农场：工具栏、面板、手机、田头聊天、帮工外观，夜间遮罩和树 HUD 两个已知缺陷。
- 宿主：菜单栏图标（tray）、全局语音快捷键、开场、安装命令行、带起灵动岛、自动更新、签名公证与 `.dmg`/`.zip`/`release.json`。`vp run package:mac`、`release`、`update-check` 改成走 Rust 的打包。
- 闸：每个 `apps/web` 路由在 `apps/mac` 都有对应页，两种主题、几种宽度截图对过；在两个真包上走一遍自动更新。

**5. 删除**
- 删掉 `apps/desktop`、`apps/web`、`apps/mobile`，以及 lan 模块（只有手机壳用）。
- 删掉没人用的包：`engine`、`base-ui`、`stories`、`bridge`（如 CLI 还要，只留它用的部分）、`testkit` 中只服务旧服务端的部分；`vp run deadcode` 清干净。
- 规矩和文档改成 Rust 的版本：`AGENTS.md`（目录、命令、规矩中只适用于 TS 服务端的那些条，例如 `make<服务>(deps)`、Zod 进门解码、`db:generate`、`paths:check`、`no-wall-clock`，各自给出 Rust 侧的对应：clippy 规则、`deny(...)`、模块依赖检查）、`docs/architecture.md`、`docs/subsystems/*`；vv-acceptance 改成对 `apps/mac` 截图（`shot:`、`hosted:`、`key:`、`mouse:` 调试脚本）。
- 闸：`vp check`、`rust:check`、`docs:verify`、`deadcode` 通过；从空家目录起 `apps/mac` 走完开场、建仓库、派工单、帮工干完、合并的整条主线。

## Alternatives considered

**只删 Electron，TS 服务端和 Rust 服务端并存**：同一套 200 个接口有两份实现，契约每改一次都要改两遍，违背「核心状态只有一份」。

**保留 `apps/web` 给手机和浏览器**：页面有两份（Solid 和 nsh），而 `apps/web` 只剩远程访问一个用途。用户选了全原生；以后如要远程访问，再从 `apps/mac/ui` 出发另做。

**把 Rust 改成契约源头，生成 TS**：nsh 页面和 CLI 本来就用 TS，zod 已经是源头，生成器和 golden 都已经有了；把源头翻过来要重写生成器，又没有新的好处。等到 TS 只剩页面的时候再考虑。

**用 git subtree 把 epona 的历史带进来**：本仓库只用 squash 合入 `main`，历史反正会压成一个提交；Note 里记下 epona 的最终提交号就够追溯。

**每段一个 PR**：每次合入时 `main` 都能用，但第 2 到第 5 段之间 TS 和 Rust 两个服务端会在 `main` 上并存很久，每个改契约的 PR 都要改两边。用户选了一个 PR：分段写成提交，闸照旧，过不了闸就不往下走。

**crate 先只把前缀换成 vibevalley-，概念对齐以后再说**：要改两次名，第二次还得改所有引用；第 1 段就照概念命名，只有 `epona-issues` 拆进 `vibevalley-server` 这一项留到第 2 段，因为它要跟着正交领域的新边界走。

## Acceptance criteria

- 仓库里没有 `apps/desktop`、`apps/server`、`apps/web`、`apps/mobile`，没有 Electron、Expo、PixiJS 依赖；`epona` 这个词不出现（`stale-names.ts` 查）。
- `packages/protocol` 是唯一的契约源头：改了 Schema 而没重新生成 Rust 类型，`server:check` 失败；Rust 服务端的线上 JSON 由 golden 对齐。
- 只有一个服务端（Rust）；`apps/cli` 的测试和 `doctor` 对着它通过。
- `apps/mac` 打出签名公证过的包，能自动更新，能带起灵动岛；工单、会话、助手、田头、农场、笔记、artifact、素材库、设置、终端都能用，截图证据附在各 PR 的 Checks 里。
- `AGENTS.md`、`docs/architecture.md`、`docs/subsystems/*` 写的是 Rust 和原生的现状；长期成立的部分沉淀进子系统文档后删掉本 Note。

## Risks

- **用户已有数据**：TS 服务端存在 PGlite 或 Postgres，Rust 服务端用 SQLite。照「内部不留兼容」不写迁移，已发版的用户升级后看不到旧工单和聊天。第 3 段之前要用户拍板：照规矩归档旧家目录从空开始，还是破例写一次性导入。
- **与 [服务端和机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md) 冲突**：那篇要外部 Postgres 和多机长连接，Rust 服务端是单机 SQLite。第 3 段之前要决定：那篇改成在 Rust 上做（sqlx 同时支持 Postgres 和 SQLite），还是删掉。
- **nsh、gpui-kit、libghostty-vt 的成熟度**：三个都是 0.x 并且变得快（nsh 0.5、gpui-kit 0.9，libghostty-vt 钉在某个 git 提交上，构建要 Zig）。nsh 能否从 workspace 包和别名解析 import，第 1 段要先验证；不行就得在 nsh 那边补，不能回到复制文件。
- **只支持 macOS**：GPUI 和 epona 只做 macOS，删掉 `apps/web` 和 `apps/mobile` 之后，Windows、Linux、手机和浏览器都用不了。
- **规矩的保护变弱**：本仓库的护栏多数是 TS 的 AST 和 lint（`practice:check`、`paths:check`、`schema-audit.ts`、`health`、`no-cjk-literal`……），Rust 侧现在几乎没有。第 5 段之前，每条要么有 Rust 侧的对应，要么明确放弃，不能悄悄丢掉。
- **追同步期间的漂移**：第 2 到第 5 段之间，TS 服务端和 Rust 服务端并存。golden 只能查契约和 projection，不能查模块里的行为。第 3 段要尽快过闸，在那之前冻结 `apps/server` 的新功能。
