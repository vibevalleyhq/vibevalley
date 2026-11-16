# Agent Note: VibeValley 全域纯 Go 收敛（笔记、Artifact）与 MyGo 双模桌面壳

Status: proposed

## Problem

在确立纯 Go 受管执行底座（[总架构路线](.agents/notes/proposed/architecture/2026-11-16-go-managed-platform-roadmap.md)）后，若将 VibeValley 上层业务域（[频道](docs/subsystems/channel.md)、[工单](docs/subsystems/issue.md)、[观察层](docs/subsystems/watch.md)、[笔记](docs/subsystems/pkm.md)、[Artifact](docs/subsystems/artifact.md)）与桌面壳继续留在 Node 24 + Electron + Swift 多进程架构中，会产生四处结构性割裂：

1. **双运行时往返绕路**：帮工在 Go `durable` 内频繁读写笔记、创建或自检 Artifact、推进工单时，若业务域仍在 Node 进程，每次工具调用均需跨进程回调并维护两套数据库连接池（PGlite 与 SQLite/Postgres）。
2. **重型 `session` 模块重复建设**：原服务端 `session` 的队列泵、轨迹日志与工作目录机器锁与 Go `durable` 完全重叠，保留两边会导致严重双源状态漂移。
3. **桌面壳多技术栈割裂且内存高企**：当前桌面版同时维护 `apps/desktop`（Electron）、`apps/island`（Swift 原生灵动岛）与 `apps/pty`（Swift 终端进程）三套工程，跨平台构建与签名链路沉重。
4. **长周期使用后记性碎片化膨胀**：缺少类似 [Claude Managed Agents Dreams](https://platform.claude.com/docs/en/managed-agents/dreams) 的离线跨会话记性去重与提炼流水线。

## Proposal

将 VibeValley 服务端全部业务模块统一收敛入 Go `internal/domain`，彻底裁撤旧重型 `session` 执行实现；用纯 Go 零 CGO 桌面框架 [`egoist/mygo`](https://github.com/egoist/mygo)（[MyGo 官方文档](https://mygo.run/zh/docs)）统一替换 Electron、`apps/island` 与 `apps/pty`；前端 `apps/web`（Solid 2）保持唯一跨宿主页面层，专职视图渲染与富交互编辑器。

## 核心业务域收敛与防双源（SSOT）铁律（`internal/domain`）

### 1. 裁撤旧 `session` 内核与双账本单向锚定

原服务端队列泵、运行轨迹与机器租约整块下沉至 [Durable 引擎](.agents/notes/proposed/architecture/2026-11-16-go-durable-vault-and-governance.md)与 `vibe-machine`，上层遵循三条防双源边界：

- **`Channel` 社交事实与 `durable_entry` 执行轨迹严格分离**：[频道](docs/subsystems/channel.md)表仅存储公开消息、问题卡片与最终汇报摘要；帮工的多轮内部推理、长工具输出与上下文压缩切点仅存于 `durable_entry`。两边通过单向幂等外键锚定：[观察层](docs/subsystems/watch.md)通过三道刹车决定叫醒帮工时，以 `chan_evt:<channelId>:<seq>` 作为 `Submission.requestId` 提交，崩溃重启绝不双跑；页面点开消息查看轨迹时，按 `sessionId` 直接经 [Chord 链路](.agents/notes/proposed/architecture/2026-11-16-go-chord-sync-and-link.md) `Watch` 对应执行视图。
- **区分两类观察职责**：业务层 `domain/watch` 专职「频道注意力与收件箱唤醒裁决」（读频道游标、过刹车、派工单蓄水池）；底层 `pkg/chord/watch` 专职「状态快照与增量传输」，命名与包边界互不混用。
- **工单（`issue`）纯信号闭环**：工单派活后不持有执行层反向回调指针，仅监听 `durable` 发出的结算信号与独立验收裁判（`Outcome Grader`）结论，达标后推进 PR 检测与完成动作。

### 2. Go 版笔记与记性蒸馏引擎（`internal/domain/pkm` & `memory`）

将笔记后端存储、图谱解析与检索迁入 Go，前端大纲键盘交互与框选编辑器继续留在 `apps/web`：

- **唯一 AST 图谱解析源**：使用纯标准库零依赖、原生 CJK 友好的 [`yuin/goldmark`](https://github.com/yuin/goldmark)（开启 CST 源码字节跨度保留，配合 [`goldmark-frontmatter`](https://pkg.go.dev/go.abhg.dev/goldmark/frontmatter) 与双链扩展）解析 PARA 目录下的 Markdown 文件。后端作为正反向链接（`backlinks`）、块引用与标签的唯一事实源，前端不再重复用正则推导图谱。
- **中英文混合全文与向量检索**：针对 [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite) 默认 `unicode61` 分词器不切分中文词组的问题，SQLite 全文虚拟表统一指定原生 `tokenize='trigram'`（参考 [SQLite FTS5 配置讨论](https://github.com/pocketbase/pocketbase/issues/193)），结合纯 Go 向量索引 [`viant/sqlite-vec`](https://github.com/viant/sqlite-vec)（云端 PostgreSQL 对应 `pgvector`）提供毫秒级混合召回，供同进程内的助手与帮工零网络开销直调。
- **后台离线记性蒸馏（Dreaming Pipeline）**：对标 [Managed Agents Dreams 规范](https://platform.claude.com/docs/en/managed-agents/dreams)，由定时任务在空闲时段拉起一个独立可追踪的归档会话，输入近期完结的帮工轨迹与当前记性快照，克隆产出一份去重、合并过期事实的新记性版本，推送至 Inbox 供用户一键审阅启用或丢弃。

### 3. Go 版 `Artifact` 与原生 `esbuild` 自愈闭环（`internal/domain/artifact`）

- **内容寻址修订与差异计算**：块文档操作状态机与网页版本按 SHA-256 去重存储，使用 Go 官方语言服务器同源的 [`hexops/gotextdiff`](https://pkg.go.dev/github.com/hexops/gotextdiff) 计算精确行级补丁。
- **进程内毫秒级编译与报错自愈**：直接内嵌纯 Go 打包器 [`github.com/evanw/esbuild/pkg/api`](https://pkg.go.dev/github.com/evanw/esbuild/pkg/api)（[esbuild 官方 API](https://esbuild.github.io/api/)），通过内存虚拟文件系统插件在 1–3 ms 内编译帮工提交的多文件 TSX / JSX / CSS 组件；一旦存在语法或引用错误，不等前端白屏，当场将带精确行列号的编译诊断作为工具错误喂回 `durable` 循环驱动帮工自行修复。
- **独立源安全预览门**：内置隔离端口/子域名的静态预览 HTTP 服务，附加强制 CSP 响应头，杜绝预览脚本读取主工作台凭据。

## `cmd/vibe-desktop`：基于 MyGo 的双模桌面壳

采用纯 Go 无 CGO 框架 [`egoist/mygo`](https://github.com/egoist/mygo)（[MyGo 中文概览](https://mygo.run/zh)）在一个不足 15 MB 的可执行文件内统一桌面全场景：

1. **GPU 原生绘制窗口承载灵动岛与快捷启动器**：使用 `mygo/ui` 包直接通过 Metal / Direct3D / OpenGL 在 GPU 上绘制刘海灵动岛、全局快捷键唤出条及内置的 Liquid Glass 毛玻璃效果，零 WebView 启动开销。当后台帮工触发 `always_ask` 权限挂起或花费达限（`budget_reached`）时，灵动岛瞬时弹出卡片，点击批准直接调用同进程 Go 方法投递信号。
2. **系统 WebView 窗口承载共享工作台**：主窗口使用操作系统自带 WebView（macOS `WKWebView`、Windows `WebView2`、Linux `WebKitGTK`）加载 `apps/web` 构建产物，经进程内 `Chord Link` 通道实时同步核心状态帧。
3. **原生终端、系统钥匙串与自动化验收**：复用 MyGo 官方插件——用系统级机密接口（macOS Keychain / Windows Credential Manager）安全托管 `internal/vault` 的根加密密钥；用内置 Ghostty 终端插件替代原 `apps/pty` 提供多仓库工作目录本地终端；用 `mygo-automation` 命令行客户端支撑智能体对桌面端窗口执行端到端点击与截图验收（[MyGo 官方文档](https://mygo.run/zh/docs)）。

## Alternatives considered

- **继续使用 Electron + Swift 独立子工程构建桌面版**：安装包体积逾百 MB、空载内存高，且 Windows 与 Linux 平台无法复用 Swift 编写的 `apps/island` 与 `apps/pty`。
- **将全部工作台主界面（含复杂富文本大纲与像素农场）都改用 `mygo/ui` 原生重画**：`apps/web` 已沉淀成熟的 Solid 2 组件体系、PixiJS 像素农场引擎（`packages/engine`）与故事书测试；主窗口用系统 WebView 复用现有页面、仅灵动岛与高频小窗用原生 GPU 绘制，能兼顾开发效率与极致响应。
- **在服务端起 Node 子进程跑 Vite/PostCSS 编译 Artifact**：破坏零 Node 单二进制边界；原生 Go `esbuild` 加预览模板内置原子样式即可满足毫秒级编译。

## Acceptance criteria

- 几十毫秒内完成包含 5,000 篇中英文混排 PARA 笔记的全量 `goldmark` 双链索引构建，`FTS5 trigram` 中文词组检索与向量混合查询准确召回且前后端双链计数严格一致。
- 帮工提交含语法错误的 TSX Artifact 时，工具层在 10 ms 内返回 `esbuild` 行列号报错并触发同轮自动修正，修正后独立源预览页面正常渲染且无法读取主站凭据。
- 离线记性蒸馏任务运行后生成独立待审记性版本，原记性集在用户确认切换前保持不变，切换或回退均为单事务原子操作。
- `vibe-desktop` 在 macOS、Windows、Linux 三平台通过纯 Go 交叉编译产出安装包；灵动岛窗口冷启动时间小于 50 ms，审批点击到受管会话恢复运行端到端延迟小于 20 ms。

## Risks

- **各操作系统自带 WebView 渲染细节差异**：脱离固定 Chromium 内核的 Electron 后，macOS `WKWebView` 与 Linux `WebKitGTK` 在少数 CSS 特性上存在差异；须在 Playwright 矩阵中纳入 WebKit 内核回归测试。
- **单向类型生成门禁缺失导致前后端失配**：从 Go `pkg/contract` 生成 `packages/protocol` TypeScript 声明与校验器的脚本须接入 `docs:verify` 级 CI 检查，未重新生成时直接阻断合入。
