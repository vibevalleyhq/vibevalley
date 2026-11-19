# Agent Note: 原生的 VibeValley：Rust 服务端为准，激进重构，删掉 Electron、TS 服务端、页面和手机壳

Status: proposed

## Problem

全原生 macOS 架构改造（R1 工具、R2 设置与供应商、R3 媒体任务机、R4 拆 `Board` 与 `server.db` 类型化表、R5 Rust 为契约与词典单一源、R6 Rust 命令行 `vibevalley-cli`，以及删除 `apps/{server,web,desktop,mobile,cli}` 与废弃 TS 包）已合入 `main`，架构现状沉淀于 [架构](docs/architecture.md) 与各子系统文档（[地基](docs/subsystems/foundation.md)、[客户端](docs/subsystems/app.md)、[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md)）。

公开发布前还剩三项实机与分发收尾未验收：真实厂商音频与麦克风设备、Developer ID 签名与公证配置、在签名公证包上走通全部发布主线与双主题路由截图。

## Proposal

持久执行、外部农机实机验证与 Web 农场视觉对照见[持久执行与驱动验收](.agents/notes/proposed/architecture/2026-11-18-native-durable-execution.md)；后续半年迭代见[原生工作台长期计划](.agents/notes/proposed/architecture/2026-11-19-native-product-roadmap.md)。

### 砍掉的（不复刻，或简化）

- **oar**：内置 Claude Code、Codex、ACP（`acp:gemini`、`grok`、`kimi`、`codebuddy`、`opencode`）、SDK（`qwen`、`qoder`）、自研 `vibevalley` 与测试用 `scripted`；不做运行时的 skills / MCP / tools 清单、额度与花费的逐厂商细节，不接 `cursor` 与 `dsh`。
- **pi-ai / pi-durable**：自研 agent（`crates/vibevalley-agent`）只接 DeepSeek（OpenAI 兼容接口），不做多厂商路由与完整价目表。
- **语音（声网 RTC）**：服务端已在 Rust 上重做（`modules/voice`）；原生页面跑在 nsh 上，宿主实现 MOSS Live 的 WebSocket 与原生音频，不接声网原生 SDK，当前边界见[语音](docs/subsystems/voice.md)。没搬的：通话中途的收件箱播报、声网区域切换、助手回复按 token 流式送出（改为按句）。
- **外部聊天接入（微信、飞书、QQ）**：已在 Rust 上重做（`modules/connector`）；飞书长连接帧按协议手写，仅对着本地替身测过，尚未连真实飞书验证。
- **手机壳与「连接到本机」**：已随 `apps/mobile` 删除，`lan.*` 与 `user.*`（账号、设备、授权）整个删除，只支持 macOS 本机单用户。
- **媒体其余种类**：已全部并入单任务机（`modules/media`）；简化的：厂商文件记在任务行上、清理失败由用户再点一次、异步轮询固定 3 秒无退避。Flash 边生成边播、转写时间线跳播与大结果播放／另存已接宿主，真实厂商结果待验。
- **命令行的 `app`、`auth`、`worker`**：`app`、`auth` 随桌面壳与远程登录删除；`worker` 由帮工经 `/mcp` 汇报取代。

### 对上指什么

在签名公证后的 `apps/mac` 发布包上，从空的家目录走通：

1. 走完开场，配好一台农机（Claude Code 或 Codex）和助手的模型。
2. 建一个仓库，建一张工单，派给一个档案。
3. 帮工在工单的 worktree 里干活；工单页看得到每一轮的轨迹；帮工经 `/mcp` 在工单串里汇报。
4. 用户在工单串里追问，帮工接着干；用户看改动，合进主分支。
5. 在田头对助手说一句话，助手建工单并派出去。
6. 定时任务到点建一张工单。
7. 命令行 `vibevalley doctor`、`issue list`、`issue create`、`channel` 发一句话，对着运行中的应用通过。
8. 退出再打开，在做的工单、会话和聊天都接得上。

页面：工作台的每个路由在 `apps/mac` 有对应页，浅色、深色两种主题各截一张；农场能进、能看见帮工在地上干活。

### 剩下的（按顺序）

1. **真实音频验收**：Flash 流式与 MOSS Live 已通过离线协议、取消与播放队列测试；真实厂商账号、麦克风权限与设备切换在单独授权后实机验证（不接声网原生 SDK）。
2. **发布环境**：配置 Apple Developer ID 证书与公证 profile，并在发布工作流（`.github/workflows/release.yml`）中验证；缺少配置时明确失败，不发布 ad-hoc 包。
3. **签名公证包最终验收**：在签名公证后的安装包上从空家目录走通[八条主线](#对上指什么)，补全工作台全路由的双主题截图与跨版本更新演练；全部完成后沉淀结论并删除本 Note。

停下的条件：主线第 1 到第 4 条在 `apps/mac` 上走不通，且根因在 nsh、gpui-kit 或 libghostty-vt 而不在本仓代码时，停下来报告用户，不绕过去。

## Alternatives considered

**原生 app + TS 服务端（不写 Rust 服务端）**：保留 TS 生态但需携带 Node 运行时；选定以 Rust 服务端为准。

**先忠实复刻 TS，再重构**：双倍工作量且会引入未用完的旧抽象；直接按 Rust 类型与深模块重写，低价值能力记入「砍掉的」。

**保留旧页面与双壳渐进迁移**：迫使 Rust 服务端长期维持旧页面与手机配对接口；已直接删除 `apps/{web,desktop,mobile,server,cli}`，只维护 macOS 原生应用与 Rust CLI。

## Acceptance criteria

- 真实 MOSS 账号下完成 Flash 语音播放、MOSS Live 麦克风权限与设备切换实机验收并归档证据。
- `vp run package:mac` 搭配 Developer ID 与公证 profile 产出签名公证包，通过 `vp run update-check` 升级与回退验证。
- [对上指什么](#对上指什么)的八条主线在签名公证包上从空家目录全部走通，工作台全路由双主题截图齐全。
- 完成后将「砍掉的」中长期边界确认落入对应子系统文档，删除本 Note。

## Risks

- **旧版 Electron 用户升级**：TS 版使用 PGlite/Postgres，原生版使用 SQLite；照「内部不留兼容」不自动迁移数据，发版说明需注明并保留旧版 Electron 下载入口。
- **0.x 原生依赖升级**：nsh、gpui-kit 与 libghostty-vt 仍在 0.x，升级可能引入接口或渲染变更，需在发版前执行完整 `vp run release:verify`。
- **只支持 macOS**：删掉浏览器页面与手机壳后，Windows、Linux、手机与浏览器无法使用。
