# 客户端

VibeValley 只有一份 Solid 2 页面（`apps/web`），由服务端在 `/` 提供，共用于桌面壳、浏览器和手机壳。页面只读服务端推送的 `StateFrame` 与查询接口，经 `VibeValleyApi` 发命令，经 `@vibevalley/protocol/host` 注入宿主能力。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 状态流连接、心跳超时重连与断线提示 | `StateFrame` 的折叠与拼装（[核心状态](docs/subsystems/core.md)） |
| 页面单向分层、Atom 状态中间层、乐观意图（`Intent`）与本地存储 | 协议形状与接口定义（[地基](docs/subsystems/foundation.md)） |
| 工作台路由、外框、浅色/深色主题与组件故事查看器（`packages/stories`） | 像素农场画布玩法（[农场的皮](docs/subsystems/farm.md)）与各页细节（[界面清单](docs/reference/farm-ui.md)） |
| 宿主契约（`host.ts`）：通知、托盘、快捷键、原生通话、窗口比例锁定（`framing`）、桌面终端（`terminal`）与标题栏避让 | 「连接到本机」服务端鉴权（[连接到本机](docs/subsystems/lan.md)）与声网令牌（[语音](docs/subsystems/voice.md)） |
| 桌面壳：Go 原生壳（`cmd/vibe-desktop`）、WebView 容器、灵动岛（`island.go`）、终端（`terminal.go`）与内嵌 / `thin_desktop` 双模式构建 | 服务端内部启动与租约（[地基](docs/subsystems/foundation.md)） |
| 手机壳：扫码配对、系统钥匙串、WebView 容器与锁屏原生通话 | |

包级说明见 [apps/web/README.md](apps/web/README.md)、[apps/web/src/farm/README.md](apps/web/src/farm/README.md) 和 [apps/mobile/README.md](apps/mobile/README.md)。

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/web/src/base/` | 纯工具层：格式化、排序、拼音搜索（`search.ts`）、中文标点转换（`typedMarks.ts`）、快捷键 |
| `apps/web/src/infra/` | 外部通信层：`frame.ts`（状态流和窄流）、`gateway.ts`（订阅流）、`query.ts`、`host.ts`、`router.ts` |
| `apps/web/src/state/` | 状态中间层：`atom.ts`（`AtomRegistry`）、`intent.ts`（乐观意图）、`stored.ts`（`localStorage` 门面）、`prefs.ts` |
| `apps/web/src/ui/`、`ui/domain/`、`ui/pixel/` | 基于 `@vibevalley/base-ui` 的无样式组件封装、线条图标（`icons.ts`）、跨模块业务展示件与像素通用组件 |
| `apps/web/src/features/<概念>/` | 按概念划分的业务模块，跨 feature 仅经 `index.ts` 导入，且按 `featureLayers`（`Primitives → Domain → Workbench → Settings`）单向依赖无环（`src/layers.test.ts` 检查） |
| `apps/web/src/farm/`、`tree/` | 像素农场与记忆树皮肤层 |
| `apps/web/src/app/` | 顶层路由表（`App.tsx`）、侧栏导航（`places.ts`）与外框（`Shell.tsx`） |
| `packages/stories/`、`apps/web/src/stories.tsx` | 按「设计体系 / 组件 / 交互 / 界面」四层组织的组件故事查看器 |
| `packages/protocol/src/host.ts` | `Host` 接口、`desktopBridge`、`mobileBridge` 与 `desktopControl` 契约 |
| `cmd/vibe-desktop/` | Go 原生桌面壳（`main.go`、`webview.go`、`island.go`、`terminal.go`、`host_bridge.go`、`keychain.go`、`embedded_stack.go`、`ipc.go`、`automation.go`） |
| `apps/mobile/src/` | Expo 手机壳（`infra/farm.ts`、`screens/PairScreen.tsx`、`screens/FarmScreen.tsx`、`infra/rtc.ts`） |

## 模型和不变量

### 页面状态与数据流

- **页面只读 `StateFrame`，心跳超时主动重连**：`infra/frame.ts` 维护唯一 `/api/v1/state` 连接并按 id `reconcile` 进 Solid store；45 秒无数据或心跳即重连，断线时直接显示未连接。
- **Atom 是唯一状态中间层**：跨组件状态 `defineAtom`、本地存储 `defineStored` 和乐观意图 `defineIntent` 统一建在 `state/` 的 `AtomRegistry` 上（由 `vibevalley/*-door` 规则检查）。
- **乐观意图（`Intent`）按阶段联合建模，等帧 `seq` 追上后结算**：
  - `Intent` 为按 `phase` 区分的判别联合（`IntentAt`），写操作带 `requestKey` 或 `sendKey` 叠加到当前帧上，等到 `frame.seq >= reply.seq` 或频道出现对应消息时才结算。
  - `VibeValleyApi` 自动解包 `{ bizCode, message, data?, error? }` 信封；错误经 `infra/api.ts` 的 `faultOf` 转为结构化 `UiFault`（携带六位 `bizCode`、语义 `tag`、`reason`、`next`、`settings` 以及由 `bizCodeMeta` 决定的 `retryable`），只挂在失败或降级分支上；组件内禁止绕过 `act.run` 直接调写接口（`vibevalley/act-door` 检查）。
- **一次性读取走 `infra/query.ts`**：自有 Query client 管缓存与失效，结果先经 Schema 解码，状态流重连时自动 `refetchOnRelink`。会话轨迹经 `features/session/runs.ts` 的 `SessionLogs` 先订直播流、再读快照并按 `seq` 与 `revision` 合并。
- **颜色收进语义调色板**：浅色/深色主题通过 `<html data-theme>` 切换，只用 `style.css` 语义色变量（`vibevalley/no-hex-color` 检查）；像素皮固定 `data-theme="light"`。
- **样式是元素上的 Tailwind v4 class**（[vv-tailwind](.agents/skills/vv-tailwind/SKILL.md)）：令牌在 `style.css` 的 `@theme`，class 名就是令牌名；零件对外收 `class`，被调用方改的样子做成变体属性。`vibevalley/style-attrs` 拦 `className` / `classList` 和只写死值的 `style`，`vibevalley/design-tokens` 拦 class 里绕过令牌的任意值。动态几何坐标、Canvas 数据、Motion 动画与 Shiki 语法高亮等外部计算值通过原生对象 `style` 保持单一所有者，且 `vibevalley/no-hex-color` 同时拦截 class 与 JSX 内联 `style` 中的硬编码十六进制色值。
- **全局 CSS 仅保留非 JSX 边界**：`style.css` 按 `@layer theme, base, components, utilities` 声明层序，仅承载重置（`reset.css`）、字体与令牌、桌面拖拽区（`[data-window-drag]`）以及消毒后富文本 DOM 后代（`Markdown.css`、`PxMarkdown.css` 与 `richText.ts` 代码块/图表）；故事宿主（`src/stories.css`）另导入 `@vibevalley/stories/style.css` 的填满画布规则，并用 `@source` 让 Tailwind 也扫查看器自己的 class。

### 宿主与多端

- **宿主接口封闭，缺省能力为 `null`**：页面通过 `currentHost()` 检测能力是否存在，不分支判断宿主类型。跨进程调用经 `@vibevalley/bridge` 按 Schema 校验。
- **远端浏览器先拿钥匙**：非回环地址打开页面时由 `features/user/entry.ts` 决定进农场、去 `/login` 还是去 `/pair`；流程见[用户和设备](docs/subsystems/user.md#怎么走)，Cookie 见[连接到本机](docs/subsystems/lan.md#模型和不变量)。
- **手机壳单连接串行切换**：`FarmConnection` 串行管理农场选择与系统钥匙串写入，切农场时取消在途入线；手机通话走原生声网 SDK（`apps/mobile/src/infra/rtc.ts`）保持锁屏不断线。

### 运行形态与二进制

Go 桌面壳（`cmd/vibe-desktop`）通过两个构建标签在同一源码上提供两种形态：

| 形态 | 构建命令 | 运行方式 | 家目录 / 服务端 | CLI 命令 |
|---|---|---|---|---|
| 独立应用包与二进制 | `vp run package:mac`（内嵌栈） | 生成 `dist/vibe-desktop` 与 `dist/VibeValley.app`（`Contents/Resources/` 含 `web`、`bin/vibe`、`icon.icns`），可选 `--web-dist` 与 `--db` | `~/.vibevalley`、默认内嵌启动平台服务栈（`embedded_stack.go`） | `vibe`（`cmd/vibe`，包内自带） |
| `thin_desktop` 瘦壳 | `env -u GOROOT CGO_ENABLED=0 go build -tags thin_desktop ./cmd/vibe-desktop` | 通过 `embedded_stack_stub.go` 剔除内嵌栈，连向 `--server` 指定的外部 `vibe-server` 实例 | 由外部 `vibe-server` 拥有家目录与仓库数据 | `vibe`（`cmd/vibe`） |
| 开发模式 | `vp run desktop:dev` | 运行 `./cmd/vibe-desktop`，配合前端开发构建调试 | 临时或开发环境变量 `$VIBEVALLEY_HOME` | `go run ./cmd/vibe` |

- **桌面端内置能力集成在单一 Go 二进制里**：基于 [`egoist/mygo`](https://github.com/egoist/mygo) 构建双模桌面壳，全部 GUI 依赖经 `arch_test.go` 隔离在 `cmd/vibe-desktop`，不再维护单独的 Electron 或 Swift 子进程：
  - **系统 WebView 与资源解析（`webview.go`）**：主窗口使用系统自带 WebView（macOS `WKWebView`、Windows `WebView2`、Linux `WebKitGTK`）经自定义 Scheme（默认 `vibe://localhost`）加载资源，按 `--web-dist` → `.app` 包内 `Contents/Resources/web` → 仓库 `apps/web/dist` → 内嵌降级页 `web_fallback.html` 顺序解析。
  - **进程内 `Chord Link`（`ipc.go`、`embedded_stack.go`）**：单机嵌栈模式通过内存管道 `BridgeTransport` 与 `ChordFrameEvent`（`chord:frame`）直连 `EmbeddedStack`，零回环 TCP 监听开销。
  - **GPU 原生灵动岛（`island.go`）**：使用 `mygo/ui` 与 `plugins/glass` 事件驱动渲染（静止时零后台定时器），直接响应 `always_ask` 权限审批与 `budget_reached` 一键提额信号。
  - **钥匙串、多仓库终端与自动化（`keychain.go`、`terminal.go`、`automation.go`、`host_bridge.go`）**：调用系统钥匙串托管 `vault.RootKey`（`--headless-check` 自动切内存替身）；受白名单根目录约束的终端控制器支持进程组清理；自动化套接字（`--automation-socket` / `MYGO_AUTOMATION`）配 `ui.Tester` 支撑无头 UI 检查；控制套接字 `$VIBEVALLEY_HOME/desktop.sock` 响应 `vibe app` 指令并安装包内 `vibe` 命令。

## 怎么走

**桌面端启动与无头校验**

1. 解析命令行、环境变量与 YAML 配置（`DesktopConfig`），初始化 `vault.RootKey`、Keychain 与宿主 IPC。
2. 嵌入模式经 `EmbeddedStack` 启动平台服务栈（或以 `thin_desktop` 连接远端 `--server`），WebView 通过 `webview.go` 加载静态页资源并挂接 `host_bridge.go`。
3. 浏览器与桌面共用开屏场景（`public/brand/opening-*.webp`），工作台取得首帧和首批查询后通知宿主退场。
4. 传入 `--headless-check` 时，`RunHeadlessCheck` 在不弹窗口的条件下顺序校验灵动岛视图、Chord Link IPC ping、WebView 资源句柄、Keychain 与自动化端点，输出 JSON 自检结果。

**工作台路由**

- 路由表在 `apps/web/src/app/App.tsx`，导航栏的条目在 `apps/web/src/app/places.ts`，设置的分区在 `apps/web/src/features/setting/SettingsPage.tsx`；以代码为准，这里不抄。农场保留侧栏，不显示工作台页头；`/tree` 和 `/pair` 在外框 `Shell` 之外。
- `infra/router.ts` 提供 Router、对象路由表与 Outlet。共同布局跨页面保留，参数变化保留页面实例，需要重建的农场按仓库显式设 key。应用布局读 route meta，不自行拆 URL。匹配、History、参数与查询字符串的约定见 [Router](apps/web/src/infra/router/README.md)。
- URL 查询字段只经 Router 更新；工单筛选由 Schema 读写，不再由 Atom 另存。未知页面、非法站内编码和不满足 Codec 的参数显示错误页，不默默跳到可写页面。
- 无样式的 Query、Router、Form、Table 归 `infra`，数据契约使用 Zod；视觉绑定归 `ui`。Form 管编辑版本、校验与明确的提交收据；Table 消费已解码的领域行，不拥有请求。字段、生命周期和受控状态的契约见 [页面基础设施](apps/web/src/infra/README.md)。

**发布构建**

- `vp run package:mac`（`scripts/release/package-mac.ts`）编译 stripped `dist/vibe-desktop`（强制小于 `40 MiB`）与 `vibe` CLI，组装 `dist/VibeValley.app`（`Info.plist` 按渠道设 Bundle ID，`Contents/Resources/` 嵌入 `web`、`bin/vibe` 与 `icon.icns`），在 macOS 上执行 ad-hoc 签名并运行 `--headless-check` 验证，再生成 `.zip`、`.dmg` 与 `dist/` 下的 `release.json`（含 `version`、`notes`、迁移表结构 SHA-256 `schema`、`page` 与 `builds` 校验）；`.github/workflows/release.yml` 在版本 tag 推送时构造草稿发布并上传产物。

## 和谁打交道

- **服务端（`cmd/vibe-server`、`internal/domain/gateway`）**：通过 `--ready-json` 或固定地址交接监听地址，在 `/` 提供静态页，在 `/api/v1/*` 提供接口与流。
- **「连接到本机」（`lan`）**：向局域网设备提供同一份页面与配对页 `/pair`。
- **宿主桥（`@vibevalley/bridge`）**：连接页面与 Go 桌面壳宿主桥、Expo 原生壳。

## 为什么这样

- **一份 Solid 2 页面服务三个宿主**：UI 与纯函数规则只写一遍，按 id `reconcile` 细粒度更新，避免高频帧触发整树重渲染。
- **状态中间层收拢到 `state/atom.ts` 的 Atom，意图按帧 `seq` 结算**：消除「请求返回先弹回旧状态、下一帧再跳过去」的闪烁。
- **样式用 Tailwind v4，不用编译期求值的样式库**：编译期求值的样式库限制要到构建才报、构建慢、样式名按位置起，还要一整套自己的 lint 和 skill；Tailwind 是 agent 最熟的写法，令牌在 `@theme` 一处。没选 CSS Modules（回到给样式起名的老问题）或 vanilla-extract（同样构建期求值）。
- **按概念分 feature，单向分层且出口显式**：跨 feature 只走 `index.ts` 并禁止成环；像素农场作为皮肤层放在 `features` 之上。
- **桌面端与平台共用单一 Go 代码库**：WebView、灵动岛、PTY 与 Keychain 直接调用 Go/pkg 原语，消除多语言进程间胶水。

## 还没做的

- 手机竖屏专属版面：[手机竖屏版面](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)。
- 页面关闭时的移动推送、macOS Developer ID 签名与公证。

## 怎么验证

- `vp run web:check`、`vp test run apps/web/src/layers.test.ts apps/web/src/stories.test.ts`：页面类型、Tailwind 的编译、令牌/门禁规则（`vibevalley/style-attrs`、`vibevalley/no-hex-color`、`vibevalley/design-tokens`）、分层方向与故事覆盖测试。
- `vp run --filter @vibevalley/web e2e`（`apps/web/test/*.spec.ts`）：各页面 Playwright 端到端与 axe 无障碍测试。
- `vp run desktop:test` 与 `vp run package:mac`：Go 桌面端全套测试（含 `-tags thin_desktop`）与 `VibeValley.app`/`.dmg`/`.zip` 打包、`--headless-check` 自检。
