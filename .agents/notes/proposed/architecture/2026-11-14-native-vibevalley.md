# Agent Note: 原生的 VibeValley：Rust 服务端为准，激进重构，删掉 Electron、TS 服务端、页面和手机壳

Status: proposed

## Problem

VibeValley 现在是 Node 服务端（`apps/server`）+ Solid 页面（`apps/web`）+ Electron 壳（`apps/desktop`）+ Expo 手机壳（`apps/mobile`）。用户在另一个仓库里把它原生改写了大半（冻结于 `fbc43d4`），已经迁进本仓库：Rust 库在 `crates/vibevalley-*`，原生应用在 `apps/mac`（GPUI 窗口 + nsh TSX 页面）。

迁进来以后看到两个问题：

- **Rust 服务端是照 TS 逐行搬的，没用上 Rust。**工具按字符串匹配 op、参数靠 `p["id"].as_str()` 手取；设置和 provider 配置全是 `serde_json::Value`（`vibevalley-server` 里约 200 处）；`vibevalley-issues/src/lib.rs` 一个 `Board` 两千多行，揉着工单、会话、工作目录、合并、起草、私聊；媒体是"图片任务机 + 其他种类打补丁"。
- **追求逐项复刻 TS 太慢。**每补一处都要先读一遍 TS 再照搬，还常发现那份改写"看着做了其实没做"（厂商调用层从没编译过、简报是另一套英文措辞、私聊帮工缺失）。

用户的决定（2026-11-14）：Rust 服务端为准；激进重构，速度优先；允许暂时回退；不需要完整复刻 oar / pi-ai 的功能。终态仍是全原生，删掉 `apps/desktop`、`apps/server`、`apps/web`、`apps/mobile`；命令行也改用 Rust 写；数据源（契约、对用户说的话、工具说明、提示）在 Rust 定义，codegen 到要用的地方，借此收掉不必要的包。所有改动合成一个 PR，分段写成提交。

同一天稍后又定了三条：只做 macOS；不走渐进迁移，页面和两个壳现在就删，不等原生界面逐个路由对过；验收是在 `apps/mac` 上把[主线](#对上指什么)走通，结果对上就行。

## Proposal

### 原则

- **Rust 为准。**服务端的行为以 Rust 为准；TS 服务端只在删除前用作对照和 e2e 安全网，不再追逐它的新改动。契约在 TS 服务端删掉后翻转为 Rust 生成 TS（见 R5）。
- **速度优先，回退可接受。**一处 TS 行为如果照搬成本高、价值低，就砍掉或简化，在本 Note 的「砍掉的」里记一行，不阻塞进度。
- **边界解码一次，门内全是类型。**HTTP、文件、厂商响应、模型给的工具参数，各在进门处解码成结构体和 enum；门内不传 `Value`，不按字符串分支。
- **深模块。**每个模块对外一个窄接口；不靠一个带 `kind` 的入口复用多种操作（沿用 [模块设计](docs/style/module-design.md) 的规矩）。
- **每段一组提交。**每段做完 `rust:check` 全绿才进下一段。页面的 e2e 和桌面版测试随页面、桌面壳一起删，之后的安全网是 Rust 的集成测试和 `apps/mac` 上的主线。

### 已完成（截至 2026-11-14，分支 `refactor/native-vibevalley`）

| 段 | 结果 |
|---|---|
| 迁入 | crates 与 `apps/mac` 改名迁入；生成器读仓库内的 `packages/protocol` 与 `apps/server`；页面直接引用 workspace 包；`apps/web/public` 移到根 `assets/`；`rust:check`、`protocol:rust:check`、`mac:check` 与 macOS CI job |
| 服务端补齐 | `/mcp` 帮工门与 `issue_report`；独立的 `vibevalley-server` 二进制（`--web`、`--ready-json`）与测试用替身 agent `pi`；私聊帮工；起草讨论串；验收标准结果；已离开的会话进历史；父工单的改动；离线 MOSS；图片、语音（含流式）任务 |
| 原生界面 | 侧栏按主仓库归并 worktree、只列真实终端、终端命名去重；终端字体回退；连接状态点移到头像 |
| R1 工具 | `modules/tool`：助手和帮工共用一套工具，每个工具一个参数结构体，宽松解析写一处（`tool::args`），按调用者（`Who`）分支；`/mcp` 与助手的循环都从它取；工具说明在 `assets/tools/`，以 Rust 为准，不再从 TS 生成；助手的语音、多人对话、音色设计、理解工具接到任务端点 |
| R2 设置 | `settings.json` 一次读成 `Stored`，MOSS 账户是 `Providers`/`Connection`，钥匙是 `Secret`（打印只出提示）；`provider.rs` 与 `setting.rs` 不再传 `Value`。工单板存储改表、工具不再绕 hub 调本服务，并进 R4 |
| R3 媒体 | `media/jobs.rs` 一个任务机：存储、准入（8 个）、按种类的槽位（图片 1、语音 8）、取消、重下、释放、重启接续写一次；图片与语音在上面，去掉 `OtherJobs`。多人对话、音色设计、克隆、转写、理解后来也加在上面（见「服务端补齐（第二批）」） |
| R6 命令行（第一步） | `crates/vibevalley-cli`（二进制 `vibevalley`，clap builder，说明按农场语言取 `cli.*` 词典）：issue（含 `--watch`、`watch`）、channel、repo、agent、session、runtime、memory、cron、artifact、pkm、worker、doctor；失败一行 JSON、退出码同 TS；`crates/vibevalley-home` 收家目录约定；`act_command` 进 `vibevalley-core::rules`。Rust 集成测试 7 个过（含 TS 版整份跑时失败的 watch）。`app`、`auth`、`chat` 不搬：桌面版、远程登录随删，`chat` 日后在 Rust 上做 |
| R5 数据源（契约、词典） | 契约以 `crates/vibevalley-protocol/src/contract/`（原 `generated/`，改手写）为准，派生 `ts_rs::TS`；`typescript.rs` 写出 `packages/protocol/src/<概念>/shapes.gen.ts`（类型、`XValues`、品牌 id，带标签的联合成员带上自己的标签）与 `endpoints.gen.ts`；`tests/typescript.rs` 查生成物最新（`vp run protocol:ts` 写）、查 id 字段都标了品牌；翻转时旧的 465 个 TS 形状与生成物逐个互相可赋值。`gen/`（`gen.ts`、`prepare.sh`、`run.sh`）删了，`protocol:rust:check` 改名 `protocol:check`（加 `vp run goldens` 重写 artifact、pkm 的 golden）；`golden/` 的样例冻结成数据。词典挪到 `crates/vibevalley-i18n/locales/`（与 `same.json`），`catalogs.ts` 仍由 `i18n:gen` 写；`i18n check` 也数 Rust 与 `apps/mac` 里的用处。仍手写的 TS，随页面删：`schema.ts` 的 zod（页面、桌面、手机壳在边界解码，`satisfies Codec` 对着生成的类型，`schema.test.ts` 对键）、`api.ts` 的端点表（带 zod 的入参、出参；`api.test.ts` 对着 `endpoints.gen.ts`）、`rules/`、`client.ts`、`stream.ts`、`host.ts`；各 `shapes.ts` 只剩常量与路径（`dayMs`、`pathOf`…）、没有 Rust 类型的 `AgentIssueLevelValues`、`CronWhenKindValues`、`MediaAudioKindValues`，与 TS 专有的 `ServerReady`、`HtmlShellCommand`、`VoiceFix`。没翻的：`native.rs` 的原生端点类型不出 TS |
| R4 拆 `Board`（第一步） | `vibevalley-issues` 并进服务端，拆成三个模块：`modules/issue`（`Board`：建单、挪状态、带话、排队、交付与取消、改字段、验收、拆单与合进父分支、起草）、`modules/session`（`Sessions`：雇帮工、每一轮、私聊、插话、叫停、放走、帮工的 `/mcp` 钥匙）、`modules/workplace`（`Workplace`：确保仓库、worktree 与 base、改动、交付合并、冲突、子工单合入、分支清理，不读工单板的状态）。写只经 `modules/ledger.rs`：已有工单的变化是带类型的 `IssueChange`，一处 `fold`；一轮的汇报由会话写成 `IssueChange::Reported`。工具的列工单、验收、带话、叫停直接调模块，不再绕 hub。合回本分支后 `cargo test --workspace` 470 个过。后续表存储与事件订阅见本批 R4 收尾 |
| 闸 1 | 删了 `apps/server`、`apps/cli`、`packages/agent`；桌面版、页面 e2e、验收沙箱（`verify-server.ts`）都起 Rust 的 `vibevalley-server`（`VIBEVALLEY_SERVER_BIN` 或 cargo 的 debug 构建），桌面版打包带两个 Rust 二进制；`prompts.json`、投影 golden 归 Rust，不再从 TS 生成；只管 TS 服务端的审计删了（服务调用路径、schema 审计、protocol-namespace、单数服务、数据库门、同步文件）；CI 的 server 检查改为等 rust 任务。建工单或派活时仓库还不是 git 的会被建起来（同 TS）。桌面版测试 5/5，核心 e2e 过 |
| 对照（删页面前的最后一次） | web e2e 在 Rust 上 243 个过约 207 个（失败的是媒体其余种类、语音、手机/局域网，及 4 个在 TS 上同样失败的）；CLI 测试 22 个过 21 个 |
| 删页面和两个壳 | 删了 `apps/web`、`apps/desktop`、`apps/mobile` 与包 `ai`、`provider`、`engine`、`base-ui`、`stories`、`async`、`home`、`health`；`lan` 与 `user`（局域网监听、配对、远程登录，19 个操作、22 个类型）从契约、服务端、页面、词典里拿掉；只对它们生效的 lint 规则 12 条、`practice`/`health` 棘轮、web 的 CI job 一并删，`main` 要求的 `web`、`desktop` 两个检查改为跟着 rust job |
| 服务端补齐（第二批） | 契约里 Rust 没答的操作全部补上：`media` 的克隆、转写、音频接续与清理、理解（9 个，另补上原来只有工具没有处理的多人对话与音色设计）；`voice` 的听写、声网授权与续期、通话的起停与收发、MOSS 校验（9 个，含声网 token 算法与通话线路）；`connector` 的 5 个操作与微信、飞书、QQ 三个适配器；`orchestrator.eval.create`。都只对着离线替身测过，没连过真的厂商。合回后 `vibevalley-server` 与 `vibevalley-protocol` 的测试 217 个过 |
| 原生页面 | `nsh check` 从 29 个类型错误到 0；图片、语音、音频（重写）、理解四个面板做完，笔记按圆点拖动与雷达跳转、频道拖动排序搬了过来；路由里没有「未移植」的页了。`nsh test` 192 个过（无头，不出图） |
| 本批集成 | 四条工作线合入 `refactor/native-vibevalley`；`main` 仍保留 `ts-final`，本批不推送、不发版 |
| R4 收尾 | 工单、会话、每轮、计数和待带的话改成 `server.db` 的类型化表；事务提交后才折核心状态；工具直调模块，轨迹与记性订阅会话事件。离线主线覆盖 MCP 汇报、追问续跑、真实 git 合并、助手派单、定时派单与重启恢复；助手起草权限与接口表一致，帮工仍被拒绝 |
| 农场交互 | 昼夜着色、树 HUD、六工具、帮工外观、频道与工单面板、成就、田头跳转和像素手机贪吃蛇；工具服从服务端动作表，拒绝显示原因。实际窗口验过昼夜、窄窗、聊天和小游戏；小摊保持未开放，小游戏不写业务账本 |
| 宿主与媒体 | TLS 与工作目录、菜单栏、开场、CLI 安装、灵动岛；本地媒体路径上传、播放跳播、另存与 PCM；Flash 由宿主持流、等待播放容量和耗尽，MOSS Live 接原生音频与 WebSocket。取消、迟到音频和页面退出有离线回归。音频命令按 FIFO 执行，灵动岛保留最新帧；HTTP 拒绝原生专用端点。集成修复主题传播和缩放触发误导航 |
| 本地打包更新 | `package:mac` 生成原生 app、DMG、ZIP 和清单；更新校验哈希、签名与路径，退出替换并保留旧包。两个 ad-hoc 包完成更新与重启，服务端健康且页面收到状态；Developer ID、公证和发布未执行 |
| 本批检查 | 格式、clippy 与 Rust 工作区测试通过（574 通过、9 忽略）；原生页面 196/196，脚本 106/106，契约生成、共享包与原生构建检查通过。集成包 0.0.3 → 0.0.4 更新后健康且收到状态帧；隔离冷启动开场退出、工作台显示已截图验证。真实模型、麦克风／设备切换、Developer ID 和公证未验 |

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

包的去向见「剩下的」第 1 步；`tsrs` 留着，`vp check` 给剩下的 TS（`apps/mac/ui`、`apps/site`、`scripts/`）做带类型的 lint 要用它。

### 砍掉的（不复刻，或简化）

- **oar**：只保留 Claude Code、Codex、通用 ACP 与测试用 scripted；不做运行时的 skills / MCP / tools 清单、额度与花费的逐厂商细节、记录回放的完整格式。
- **pi-ai / pi-durable**：自研 agent 只接 DeepSeek（OpenAI 兼容接口），不做多厂商路由、价格表与对话持久化的完整语义；压缩用最简单的截断摘要。
- **语音（声网 RTC）**：服务端已在 Rust 上重做（`modules/voice`）。原生页面跑在 nsh 里，没有浏览器的 WebRTC；宿主实现 MOSS Live 的 WebSocket 与原生音频，未接声网原生 SDK，当前边界见[语音](docs/subsystems/voice.md)。没搬的：通话中途的收件箱播报、声网的区域切换、助手的话按 token 流式送出（改成按句）。
- **外部聊天接入（微信、飞书、QQ）**：已在 Rust 上重做（`modules/connector`）。没搬的：汇报按工单阶段决定还推不推（只看用户读没读、后面有没有新话）、待发条数的内存缓存、落盘的坏收件行兜底（收件按列存，不会有）；飞书长连接的帧是照它 SDK 的协议手写的，只对着本地替身测过，没连过真的飞书。
- **手机壳与「连接到本机」**：已随 `apps/mobile` 删除，`lan.*` 与 `user.*`（账号、设备、授权）整个删除。
- **媒体其余种类**：已做（见上）。简化的：厂商文件记在任务自己的行上，没有单独的表；清理失败不在开机时重试，由用户再点一次；任务轮询固定 3 秒，没有退避。Flash 边生成边播、转写时间线跳播和大结果播放／另存已接到宿主，真实厂商结果未验。
- **命令行的 `app`、`auth`、`chat`**：随桌面版、远程登录删；终端里和自研 agent 对话日后在 Rust 上做。

### 对上指什么

合入前在 `apps/mac` 签名的包上，从空的家目录走通：

1. 走完开场，配好一台农机（Claude Code 或 Codex）和助手的模型。
2. 建一个仓库，建一张工单，派给一个档案。
3. 帮工在工单的 worktree 里干活；工单页看得到每一轮的轨迹；帮工经 `/mcp` 在工单串里汇报。
4. 用户在工单串里追问，帮工接着干；用户看改动，合进主分支。
5. 在田头对助手说一句话，助手建工单并派出去。
6. 定时任务到点建一张工单。
7. 命令行 `vibevalley doctor`、`issue list`、`issue create`、`channel` 发一句话，对着运行中的应用通过。
8. 退出再打开，在做的工单、会话和聊天都接得上。

页面：工作台的每个路由在 `apps/mac` 有对应页，两种主题各截一张；农场能进、能看见帮工在地上干活。不要求和 TS 版像素一致，也不要求和它逐行为一致。

### 剩下的（按顺序）

1. **清理检查的存量。**`deadcode` 仍列出 189 个未用导出、206 个未用类型和 4 个未用依赖目录项；词典检查仍有迁移遗留的 809 项问题。打包、发布、验收沙箱已改用原生路径。
2. **真实音频验收。**Flash 与 MOSS Live 已做离线协议、取消和播放队列验证；真实厂商、麦克风权限与设备切换未验，单独授权后执行。不接声网原生 SDK。
3. **发布环境。**Developer ID 身份和公证 profile 尚未配置验收；CI 缺配置时失败，不发布 ad-hoc 包。
4. **最终验收与合入 `main`。**在签名包上走完[八条主线](#对上指什么)，补全每个路由的两主题截图，把证据附在同一个 PR 的 Checks 后 squash 合入；本批只合入原生集成分支。

停下的条件：主线第 1 到第 4 条在 `apps/mac` 上走不通，并且原因在 nsh、gpui-kit 或 libghostty-vt 里而不在本仓库的代码里，就停下来报告用户，不绕过去。

## Alternatives considered

**原生 app + TS 服务端（不写 Rust 服务端）**：服务端只有一份、保留 TS 生态与仓库护栏，代价是带 Node 运行时。用户选了 Rust 服务端为准。

**先忠实复刻 TS，再重构**：每一处都要先对照 TS 搬一遍，再改一遍，比直接按 Rust 的方式写慢；对照的价值由 e2e 安全网提供就够了。

**现在就把契约翻转成 Rust 为准**：TS 服务端还在跑 e2e 对照，它需要 zod 契约；等 `apps/server` 删掉再翻转，只翻一次。

**先留着页面和两个壳跑 e2e，`apps/mac` 逐个路由对过再删（本 Note 上一版的闸 2）**：留着它们，Rust 服务端就要一直答旧页面要的每个操作（手机配对、语音、连接器的页面也在内），「砍掉的」砍不干净，手写的 zod 和端点表也删不掉。用户选了速度：现在就删，从删掉到原生界面补齐之间没有能日用的应用，兜底是 `main`（`ts-final`）和上一个 Electron 包。

**保留 `OtherJobs`，按种类各写各的任务机**：每种都要重写排队、取消、恢复、释放，正是现在重复与不一致的来源。

## Acceptance criteria

- 仓库里没有 `apps/desktop`、`apps/server`、`apps/web`、`apps/mobile`，没有 Electron、Expo、PixiJS；旧改写仓库的名字不出现（`stale-names.ts` 查）。
- `vibevalley-server` 门内没有 `serde_json::Value` 的业务传递（只在进出边界）；没有按 op 字符串分支的工具分发；没有 `Board` 这样的跨领域大对象。
- 契约、词典、工具说明与提示以 Rust 为准，TS 由它生成，检查保证最新；`packages/` 下只剩生成物或页面专用的包。
- 命令行是 Rust 的 `vibevalley-cli`，没有 `apps/cli`。
- 只有一个服务端；命令行的集成测试与 `doctor` 对着它通过；`apps/mac` 打出签名公证的包，能自动更新。
- [对上指什么](#对上指什么)的主线八条在那个包上从空家目录走通，页面的截图齐全，证据附在 PR 的 Checks 里。
- 「砍掉的」里每一项要么在文档里写明不做，要么已在 Rust 上实现。

## Risks

- **重构期间回退**：允许。页面的 e2e 删掉以后，主线以外的错要到使用中才发现；主线由第 2 步的集成测试和合入前的验收守住。媒体其余种类与语音按砍掉的处理。
- **中间没有能日用的应用**：第 1 步删掉页面和 Electron 壳以后，到第 3 步原生界面补齐之前，这个分支上没有完整可用的应用；分支拖得越久，`main` 上的修复越要手工对到 Rust。
- **已发版的用户**：TS 服务端在 PGlite/Postgres，Rust 用 SQLite；照「内部不留兼容」不迁移，升级后从空开始，Electron 版也不会自动更新到原生版。发版说明里要写明，并保留上一个 Electron 包的下载。
- **nsh、gpui-kit、libghostty-vt 都是 0.x**：升级可能要跟着改；nsh 能解析 workspace 包已验证。
- **只支持 macOS**：删掉页面与手机壳后，Windows、Linux、手机与浏览器都用不了。
- **仓库护栏**：TS 的 AST 与 lint 审计对 Rust 不适用；R1–R4 里每段都要把对应的约束写成 clippy 规则、类型或测试，不能只靠文字。
