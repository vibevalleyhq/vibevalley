# Agent Note: 原生的 VibeValley：Rust 服务端为准，激进重构，删掉 Electron、TS 服务端、页面和手机壳

Status: proposed

## Problem

VibeValley 现在是 Node 服务端（`apps/server`）+ Solid 页面（`apps/web`）+ Electron 壳（`apps/desktop`）+ Expo 手机壳（`apps/mobile`）。用户在另一个仓库里把它原生改写了大半（冻结于 `fbc43d4`），已经迁进本仓库：Rust 库在 `crates/vibevalley-*`，原生应用在 `apps/mac`（GPUI 窗口 + nsh TSX 页面）。

迁进来以后看到两个问题：

- **Rust 服务端是照 TS 逐行搬的，没用上 Rust。**工具按字符串匹配 op、参数靠 `p["id"].as_str()` 手取；设置和 provider 配置全是 `serde_json::Value`（`vibevalley-server` 里约 200 处）；`vibevalley-issues/src/lib.rs` 一个 `Board` 两千多行，揉着工单、会话、工作目录、合并、起草、私聊；媒体是"图片任务机 + 其他种类打补丁"。
- **追求逐项复刻 TS 太慢。**每补一处都要先读一遍 TS 再照搬，还常发现那份改写"看着做了其实没做"（厂商调用层从没编译过、简报是另一套英文措辞、私聊帮工缺失）。

用户的决定（2026-11-14）：Rust 服务端为准；激进重构，速度优先；允许暂时回退；不需要完整复刻 oar / pi-ai 的功能。终态仍是全原生，删掉 `apps/desktop`、`apps/server`、`apps/web`、`apps/mobile`；命令行也改用 Rust 写；数据源（契约、对用户说的话、工具说明、提示）在 Rust 定义，codegen 到要用的地方，借此收掉不必要的包。所有改动合成一个 PR，分段写成提交。

## Proposal

### 原则

- **Rust 为准。**服务端的行为以 Rust 为准；TS 服务端只在删除前用作对照和 e2e 安全网，不再追逐它的新改动。契约在 TS 服务端删掉后翻转为 Rust 生成 TS（见 R5）。
- **速度优先，回退可接受。**一处 TS 行为如果照搬成本高、价值低，就砍掉或简化，在本 Note 的「砍掉的」里记一行，不阻塞进度。
- **边界解码一次，门内全是类型。**HTTP、文件、厂商响应、模型给的工具参数，各在进门处解码成结构体和 enum；门内不传 `Value`，不按字符串分支。
- **深模块。**每个模块对外一个窄接口；不靠一个带 `kind` 的入口复用多种操作（沿用 [模块设计](docs/style/module-design.md) 的规矩）。
- **每段可回退。**每个重构段一组提交，`rust:check` 全绿、web e2e 核心部分不退步才进下一段。

### 已完成（截至 2026-11-14，分支 `refactor/native-vibevalley`）

| 段 | 结果 |
|---|---|
| 迁入 | crates 与 `apps/mac` 改名迁入；生成器读仓库内的 `packages/protocol` 与 `apps/server`；页面直接引用 workspace 包；`apps/web/public` 移到根 `assets/`；`rust:check`、`protocol:rust:check`、`mac:check` 与 macOS CI job |
| 服务端补齐 | `/mcp` 帮工门与 `issue_report`；独立的 `vibevalley-server` 二进制（`--web`、`--ready-json`）与测试用替身 agent `pi`；私聊帮工；起草讨论串；验收标准结果；已离开的会话进历史；父工单的改动；离线 MOSS；图片、语音（含流式）任务 |
| 原生界面 | 侧栏按主仓库归并 worktree、只列真实终端、终端命名去重；终端字体回退；连接状态点移到头像 |
| R1 工具 | `modules/tool`：助手和帮工共用一套工具，每个工具一个参数结构体，宽松解析写一处（`tool::args`），按调用者（`Who`）分支；`/mcp` 与助手的循环都从它取；工具说明在 `assets/tools/`，以 Rust 为准，不再从 TS 生成；助手的语音、多人对话、音色设计、理解工具接到任务端点 |
| R2 设置 | `settings.json` 一次读成 `Stored`，MOSS 账户是 `Providers`/`Connection`，钥匙是 `Secret`（打印只出提示）；`provider.rs` 与 `setting.rs` 不再传 `Value`。工单板存储改表、工具不再绕 hub 调本服务，并进 R4 |
| R3 媒体 | `media/jobs.rs` 一个任务机：存储、准入（8 个）、按种类的槽位（图片 1、语音 8）、取消、重下、释放、重启接续写一次；图片与语音在上面，去掉 `OtherJobs`。多人对话、音色设计、克隆、转写、理解按 `Ask` 加一个变体即可，暂不做 |
| R6 命令行（第一步） | `crates/vibevalley-cli`（二进制 `vibevalley`，clap builder，说明按农场语言取 `cli.*` 词典）：issue（含 `--watch`、`watch`）、channel、repo、agent、session、runtime、memory、cron、artifact、pkm、worker、doctor；失败一行 JSON、退出码同 TS；`crates/vibevalley-home` 收家目录约定；`act_command` 进 `vibevalley-core::rules`。Rust 集成测试 7 个过（含 TS 版整份跑时失败的 watch）。`app`、`auth`、`chat` 不搬：桌面版、远程登录随删，`chat` 日后在 Rust 上做 |
| R5 数据源（契约、词典） | 契约以 `crates/vibevalley-protocol/src/contract/`（原 `generated/`，改手写）为准，派生 `ts_rs::TS`；`typescript.rs` 写出 `packages/protocol/src/<概念>/shapes.gen.ts`（类型、`XValues`、品牌 id，带标签的联合成员带上自己的标签）与 `endpoints.gen.ts`；`tests/typescript.rs` 查生成物最新（`vp run protocol:ts` 写）、查 id 字段都标了品牌；翻转时旧的 465 个 TS 形状与生成物逐个互相可赋值。`gen/`（`gen.ts`、`prepare.sh`、`run.sh`）删了，`protocol:rust:check` 改名 `protocol:check`（加 `vp run goldens` 重写 artifact、pkm 的 golden）；`golden/` 的样例冻结成数据。词典挪到 `crates/vibevalley-i18n/locales/`（与 `same.json`），`catalogs.ts` 仍由 `i18n:gen` 写；`i18n check` 也数 Rust 与 `apps/mac` 里的用处。仍手写的 TS，随页面删：`schema.ts` 的 zod（页面、桌面、手机壳在边界解码，`satisfies Codec` 对着生成的类型，`schema.test.ts` 对键）、`api.ts` 的端点表（带 zod 的入参、出参；`api.test.ts` 对着 `endpoints.gen.ts`）、`rules/`、`client.ts`、`stream.ts`、`host.ts`；各 `shapes.ts` 只剩常量与路径（`dayMs`、`pathOf`…）、没有 Rust 类型的 `AgentIssueLevelValues`、`CronWhenKindValues`、`MediaAudioKindValues`，与 TS 专有的 `ServerReady`、`HtmlShellCommand`、`VoiceFix`。没翻的：`native.rs` 的原生端点类型不出 TS |
| 闸 1 | 删了 `apps/server`、`apps/cli`、`packages/agent`；桌面版、页面 e2e、验收沙箱（`verify-server.ts`）都起 Rust 的 `vibevalley-server`（`VIBEVALLEY_SERVER_BIN` 或 cargo 的 debug 构建），桌面版打包带两个 Rust 二进制；`prompts.json`、投影 golden 归 Rust，不再从 TS 生成；只管 TS 服务端的审计删了（服务调用路径、schema 审计、protocol-namespace、单数服务、数据库门、同步文件）；CI 的 server 检查改为等 rust 任务。建工单或派活时仓库还不是 git 的会被建起来（同 TS）。桌面版测试 5/5，核心 e2e 过 |
| 对照 | web e2e 在 Rust 上 243 个过约 207 个（失败的是媒体其余种类、语音、手机/局域网，及 4 个在 TS 上同样失败的）；CLI 测试 22 个过 21 个 |

### 重构（按顺序）

**R1 工具：一套带类型的工具，助手和帮工共用**
- `trait Tool { type Args: DeserializeOwned + JsonSchema; fn run(&self, who: &Caller, args: Self::Args) -> Result<String, Refusal>; }`，每个工具一个参数结构体，`schemars` 从结构体出 JSON Schema，文档注释即参数说明。
- 宽松解析只写一层：数字字符串、`"true"`、`null` 当缺省、多余字段忽略；解析失败给模型的话统一一处写。
- 助手（`orchestrator/tools.rs` 按 op 字符串匹配）与帮工（`mcp/helper.rs`）合并成一个工具集，按调用者选子集；`/mcp` 与助手的循环都从它取。
- 工具说明以 Rust 为准，删掉 `tools.json`、`session_tools.json` 及其生成。

**R2 去掉门内的 `serde_json::Value`**
- 设置与 provider 配置：`settings.json` 一次读成 `Settings`/`Providers` 结构体（连接、绑定、钥匙用 `Secret`），所有 `p["speech"]["connection"]` 改成字段访问。
- 工单板的存储：`Store` 里按 JSON 文档存的工单、会话、额外信息，改成各自的表（SQLite，和 `server.db` 合并成一个库）。
- 厂商响应在 `vendor.rs` 进门即成结构体（大多已是），任务机不再传 `Value`。

**R3 媒体：一个任务机**
- `trait JobKind`：校验与准备、执行（立即 / 任务轮询 / 流式）、结果怎么存、视图；排队、并发上限、取消、下载重试、恢复、释放、重启接续由任务机写一次。
- 图片、语音、多人对话、音色设计、克隆、转写、理解都实现它；拆掉现在的 `OtherJobs` 补丁。
- 存储按列（种类、阶段、远端任务、结果附件或输入、用量、元数据），不再一行一个 JSON。

**R4 拆 `Board`：工单、会话、工作目录三个模块**
- `vibevalley-issues` 并进 `vibevalley-server`，按正交领域的边界拆：issue（状态、指派、起草、拆分、验收）、session（雇佣、每一轮、私聊、投递）、workplace（worktree、合并、冲突、分支清理）。
- 每个迁移是一个带类型的命令，状态变化只经事实；去掉散落的 `self.update(|t| ...)`。
- 会话的轨迹、报告、记性经事实流出，watch、频道、游戏只订阅。

**R5 数据源在 Rust，codegen 到各处**
- 契约：`vibevalley-protocol` 的 Rust 类型为准（`ts-rs` 或 `specta`），生成 TS 类型给 `apps/mac/ui`；删掉 zod、`gen/gen.ts`、`gen/golden.ts` 与 projection golden，`packages/protocol` 只剩生成物（或并进 `apps/mac/ui`）。
- 对用户说的话：词典归 `vibevalley-i18n`，生成 TS 的键与目录给页面；`packages/i18n` 只剩生成物。
- 工具说明与提示：已在 `assets/`（R1），`gen/orchestrator.ts` 删掉，`prompts.json` 直接归 Rust。
- 只有页面用的纯逻辑（`packages/pkm`、`packages/artifact` 的编辑器状态机）挪进 `apps/mac/ui`；规则与 Rust 的 `vibevalley-pkm`、`vibevalley-artifact` 共用一份测例（golden）。
- 改数据源只改 Rust 一处，生成物由检查保证最新。

**R6 命令行用 Rust**
- `crates/vibevalley-cli`（clap），照现在的命令一条一个操作，经 HTTP 调服务端，类型直接用 `vibevalley-protocol`；家目录约定（`packages/home`）并进 Rust 的一处，服务端、命令行、原生应用共用。
- `apps/cli` 的测试改成 Rust 集成测试，起真的 `vibevalley-server`；之后删 `apps/cli`。

包的去向：`agent`、`ai`、`provider` 随闸 1 删；`bridge`、`engine`、`base-ui`、`stories`、`async`、`testkit`、`home` 随页面、桌面、手机壳与 TS 命令行删；`protocol` 的类型、`i18n` 的目录已是生成物（R5），`protocol` 手写的 zod、端点表、`rules/` 与客户端随页面删，之后只剩生成物与 `t`、`format`；`pkm`、`artifact` 挪进 `apps/mac/ui`；`health`、`tsrs` 看页面剩下的 TS 还需不需要再定。

### 砍掉的（不复刻，或简化）

- **oar**：只保留 Claude Code、Codex、通用 ACP 与测试用 scripted；不做运行时的 skills / MCP / tools 清单、额度与花费的逐厂商细节、记录回放的完整格式。
- **pi-ai / pi-durable**：自研 agent 只接 DeepSeek（OpenAI 兼容接口），不做多厂商路由、价格表与对话持久化的完整语义；压缩用最简单的截断摘要。
- **语音（声网 RTC）与外部聊天接入（微信、飞书、QQ）**：不在 TS 删除的闸里；先删，日后按需在 Rust 上重做。
- **手机壳与「连接到本机」**：随 `apps/mobile` 删除，`lan.*` 与远程登录相关的 `user.*` 一并删除。
- **媒体其余种类**：多人对话、音色设计、克隆、转写、理解暂不做（vendor 调用已有），要时在 `Ask` 里加。
- **命令行的 `app`、`auth`、`chat`**：随桌面版、远程登录删；终端里和自研 agent 对话日后在 Rust 上做。

### 闸与删除

1. ~~R1–R3 完成后删 `apps/server`、`apps/cli`、`packages/agent`，Electron 改带 Rust 服务端过渡~~（已做）。`packages/ai`、`packages/provider` 只剩页面的语音在用，随页面删。
   - 欠着：文档里约 420 处代码路径还指着 TS 服务端（`docs:verify` 红）；`deadcode` 报 `packages/` 里约 140 个没人用的导出（生成器经动态路径用到一部分，随 R5 变成生成物时清）。
2. R4–R6 完成，`apps/mac` 覆盖 `apps/web` 每个路由（截图对过）：删 `apps/desktop`、`apps/web`、`apps/mobile` 与只为它们存在的包；`AGENTS.md`、`docs/architecture.md`、`docs/subsystems/*`、vv-acceptance 改写成 Rust 与原生的现状。
3. 打包、签名公证、自动更新、带起灵动岛在 `apps/mac` 上补齐后，发版。

## Alternatives considered

**原生 app + TS 服务端（不写 Rust 服务端）**：服务端只有一份、保留 TS 生态与仓库护栏，代价是带 Node 运行时。用户选了 Rust 服务端为准。

**先忠实复刻 TS，再重构**：每一处都要先对照 TS 搬一遍，再改一遍，比直接按 Rust 的方式写慢；对照的价值由 e2e 安全网提供就够了。

**现在就把契约翻转成 Rust 为准**：TS 服务端还在跑 e2e 对照，它需要 zod 契约；等 `apps/server` 删掉再翻转，只翻一次。

**保留 `OtherJobs`，按种类各写各的任务机**：每种都要重写排队、取消、恢复、释放，正是现在重复与不一致的来源。

## Acceptance criteria

- 仓库里没有 `apps/desktop`、`apps/server`、`apps/web`、`apps/mobile`，没有 Electron、Expo、PixiJS；旧改写仓库的名字不出现（`stale-names.ts` 查）。
- `vibevalley-server` 门内没有 `serde_json::Value` 的业务传递（只在进出边界）；没有按 op 字符串分支的工具分发；没有 `Board` 这样的跨领域大对象。
- 契约、词典、工具说明与提示以 Rust 为准，TS 由它生成，检查保证最新；`packages/` 下只剩生成物或页面专用的包。
- 命令行是 Rust 的 `vibevalley-cli`，没有 `apps/cli`。
- 只有一个服务端；`apps/cli` 的测试与 `doctor` 对着它通过；`apps/mac` 打出签名公证的包，能自动更新。
- 「砍掉的」里每一项要么在文档里写明不做，要么已在 Rust 上实现。

## Risks

- **重构期间回退**：允许，但核心 e2e（工单、会话、频道、助手、笔记、artifact）退步就停下修；媒体其余种类与语音按砍掉的处理。
- **用户已有数据**：TS 服务端在 PGlite/Postgres，Rust 用 SQLite；照「内部不留兼容」不迁移，已发版用户升级后从空开始。发版前要用户确认。
- **与 [服务端和机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md) 冲突**：那篇的外部 Postgres 与多机长连接不在本计划内；删 `apps/server` 前要决定在 Rust 上重做还是删掉那篇。
- **nsh、gpui-kit、libghostty-vt 都是 0.x**：升级可能要跟着改；nsh 能解析 workspace 包已验证。
- **只支持 macOS**：删掉页面与手机壳后，Windows、Linux、手机与浏览器都用不了。
- **仓库护栏**：TS 的 AST 与 lint 审计对 Rust 不适用；R1–R4 里每段都要把对应的约束写成 clippy 规则、类型或测试，不能只靠文字。
