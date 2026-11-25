# Agent Note: Artifact 安装为本地轻应用（macOS 跨进程 App Shim）

Status: proposed

## Problem

在 VibeValley 中，用户、主助手与执行会话共同创作 12 类 `ArtifactType`（`docs`、`outline`、`slides`、`dashboard`、`motion`、`whiteboard`、`design`、`design-system`、`sheet`、`prototype`、`diagram`、`storyboard`），统一落盘于 `<storage>/artifact/<id>/` 并支持 Loro CRDT 多人/多 Agent 实时协同（[Artifact 子系统](docs/subsystems/artifact.md)）。

当前所有作品只能在主工作台 `/artifacts/:id` 或对话旁栏中打开，缺少将某个高频作品「安装成桌面上一个独立轻量应用」的能力：

1. 用户希望通过 Spotlight / Launchpad 秒开指定作品（如项目看板、每日仪表盘、常用原型工具），并在 macOS Dock、`Cmd+Tab`、菜单栏应用名与系统通知中拥有独立的应用身份与图标。
2. 即使脱离主工作台侧边栏，桌面轻应用仍需与 VibeValley 保持活体联动：Agent 在频道中修改作品结构或样式时，桌面窗口应实时热更新；同时避免像独立完整进程那样复制整套 GPUI / `nsh` / 嵌入式服务端状态而造成内存叠加与升级同步负担。

## Proposal

采用 **方案 B（宿主联动 + macOS 跨进程 App Shim）**：借鉴 Chromium `app_shim` / `remote_cocoa` 的窗口与引擎分离思想，在 macOS 上通过一个极薄的独立宿主外壳（Shim `.app`）拥有系统身份与窗口生命期，把真正的状态、CRDT 协同、原生组件渲染与 Agent 桥接全部留在唯一的 VibeValley 宿主进程中。

### 1. Bundle 结构与极小磁盘占用

将单个作品安装到用户目录 `~/Applications/VibeValley Apps/<作品名>.app`（无需管理员权限，自动接入 Spotlight 与 Launchpad），单包体积控制在数百 KB 量级，不包含完整的 GPUI / 服务端二进制：

```text
~/Applications/VibeValley Apps/<作品名>.app/
└── Contents/
    ├── Info.plist                # 唯一 CFBundleIdentifier: dev.vibevalley.applet.<artifact_id>
    │                             # 写入不可变元信息：VVArtifactId、VVServerHome、VVChannel、VVWindowFlags
    ├── MacOS/
    │   └── vibevalley-shim       # 极薄 prebuilt Mach-O App Shim（AppKit NSWindow + IPC + 图层接收/WebView）
    ├── Resources/
    │   └── AppIcon.icns          # 按 ArtifactType 或用户选择的封面动态生成 .icns
    └── _CodeSignature/           # 安装时一次性本机 ad-hoc 签名（codesign --force --sign -）
```

- 作品正文、协同状态与缓存永远保存在宿主的 `<storage>/artifact/<id>/` 与 `$VIBEVALLEY_HOME` 中，运行时**严禁修改 `.app` 包内任何文件**，确保签名永不失效。
- 安装完成后调用 `lsregister -f <app_path>` 立即刷新 LaunchServices 与 Finder 图标缓存；卸载时严格校验 `CFBundleIdentifier` 前缀为 `dev.vibevalley.applet.` 后删除对应包。

### 2. 进程归属与宿主唤醒

- **Shim 进程（每开启一个轻应用 1 个极薄进程）**：仅运行 macOS `NSApplication` 主循环，负责 `NSWindow`、Dock 图标、`Cmd+Tab` 身份、菜单栏应用名、系统通知归属以及窗口快捷键/置顶状态。
- **VibeValley 宿主进程（全局唯一）**：持有唯一的 GPUI 渲染管线、`nsh` TSX 运行时、`crates/rich`、Loro `PresenceHub`、`BridgeHub` 与本地回环 `vibevalley-server`（[客户端](docs/subsystems/app.md)）。
- **按需无头唤醒**：当用户点击桌面轻应用而宿主尚未启动时，Shim 在后台静默拉起 `VibeValley.app`（不强弹主工作台窗口，支持 headless/accessory 唤醒标志），待宿主就绪后建立本地 IPC 会话并渲染 `/standalone/artifact/:id`。

### 3. 跨进程零拷贝渲染桥（B1 公开 API 优先，B2 备选）

为绕开 macOS 不允许跨进程直接 `NSView` 父子挂载的限制，围绕零拷贝 GPU 合成设计两条验证轨：

- **B1 轨（优先做 PoC，100% Apple 公开 API）**：
  - 宿主侧在离屏 Metal 纹理（由双缓冲/三缓冲 `IOSurface` 支撑）中渲染独立的 `/standalone/artifact/:id` 视图（复用 `ArtifactDirectoryView` 去掉工作台侧栏）。
  - 宿主通过 `IOSurfaceCreateMachPort`（或 XPC `IOSurface` 句柄）将帧句柄零拷贝传给 Shim，Shim 在 `NSWindow` 的 `CAMetalLayer` 上直接绑定展示，只在窗口尺寸变化或新帧提交时同步。
- **B2 轨（Chromium / WebKit 同源备选方案）**：
  - 宿主渲染后生成跨进程 `CAContext` ID，Shim 窗口内部挂载 `CALayerHost` 并指向该 `contextId`，交由 macOS `WindowServer` 在 GPU 侧直接跨进程合成；延迟更低且天然覆盖复杂图层树，但依赖 `QuartzCore` 半私有符号，需先评估长期系统兼容性。
- **`prototype` 类型（`<WebView>`）的分流处理**：
  - 其余 11 类全部由 GPUI + `nsh` + `crates/rich` 原生渲染；唯有 `prototype`（`structure/index.html`）本身运行在 `WKWebView` 内，若在 B1 离屏管线中嵌套会增加复杂度，因此 Shim 可为 `prototype` 直接内置沙箱 `WKWebView`（经 `127.0.0.1` 或 `WKURLSchemeHandler` 读取作品资源与协同更新），无需把 WebView 再经一次离屏纹理转拷。

### 4. 精简版跨进程控制面（轻量 `remote_cocoa` 契约）

参考 Chromium `remote_cocoa` 的边界拆分，Shim 与宿主间仅传输极简结构化 IPC 消息（Unix Domain Socket / XPC）：

1. **生命周期与视口同步**：创建/销毁轻应用会话、窗口逻辑宽高与 `backingScaleFactor`、主题/动效偏好。
2. **输入事件回传**：鼠标移动/点击/滚轮（含惯性）、键盘按键与修饰键、窗口聚焦/失焦、原生剪贴板与拖放路径。
3. **输入法桥（`NSTextInputClient`）**：在 Shim 侧实现轻量 `NSTextInputClient`，把中文/多语种输入法预编辑串与选区坐标映射回宿主文档光标，保证候选窗定位准确。
4. **原生窗口能力与断点重连**：置顶（Floating Window Level）、标题同步、通知回调与「在 VibeValley 主窗口中打开」动作；宿主意外重启时 Shim 展示轻重连态并在毫秒级自动恢复绑定。

### 5. 权限与安全模型（借鉴 Claude Desktop 分级模型）

- **默认沙箱**：`prototype` 脚本与展示层不具备宿主机文件系统读写与终端执行权限。
- **按能力显式授权**：安装或设置面板按开关提供系统级能力：窗口置顶（Always-on-Top）、系统通知、全局唤起快捷键、仅驻留菜单栏（`LSUIElement` + 参考 [apps/island](apps/island/README.md) 的 Swift AppKit 轻量经验）。
- **受限作品本地存储**：后续若需支持小工具类 Artifact（如番茄钟、本地表单）持久化状态，提供严格限定在 `<storage>/artifact/<id>/` 作用域内的 KV/State API，而非开放任意本地目录写权限。

### 6. 分阶段 PoC 推进顺序

- **Stage 0 — 跨进程渲染技术 PoC**：独立验证 GPUI 离屏 Metal `IOSurface` 导出（B1）与极薄 Swift/Rust `vibevalley-shim`（`CAMetalLayer` + 基础键鼠回传）是否能稳定跑到 60fps 并支持 HiDPI 与中文输入法候选框；必要时对比 B2（`CAContext` / `CALayerHost`）。
- **Stage 1 — 宿主单作品路由与 IPC 闭环**：在 `apps/mac` 与 `apps/mac/ui` 增加无工作台侧栏的 `/standalone/artifact/:id` 视图、按需后台无头启动与断线重连。
- **Stage 2 — 安装器与管理界面**：实现 bundle 生成（`Info.plist` + `.icns` + `vibevalley-shim` 写入）、ad-hoc 签名、`lsregister` 注册与卸载，并在作品页右上角提供「安装为本地应用」入口。
- **Stage 3 — 增强能力**：菜单栏常驻模式、作品专属持久化 KV、全局快捷键与按需离线 `prototype` 便携导出。

## Industry survey

| 方案代表 | 产物与机制 | 优点 | 与 VibeValley 的差距/借鉴点 |
|---|---|---|---|
| **Chrome PWA App Shim** | `~/Applications/Chrome Apps.localized/*.app` 放极薄 `app_mode_loader`，结合 `remote_cocoa`（Mojo IPC）+ `CAContext`/`CALayerHost` 跨进程合成 | 独立 Dock/`Cmd+Tab`/Spotlight/通知归属；宿主与渲染引擎单一不重复；升级无需重复制引擎 | 这套 `app_shim` + 精简 `remote_cocoa` 分层最契合 VibeValley，区别在于我们先以公开 API `IOSurface` 做 B1 验证 |
| **Safari Sonoma+「添加到程序坞」** | `~/Applications/*.app`（仅 ~18 KB，无二进制），拉起系统私有 `com.apple.Safari.WebApp` | 体积极小、系统级隔离 | 苹果私有能力，第三方无法调用，且仅能跑网页，不支持 11 类原生 GPUI 作品 |
| **Claude Desktop「Install as app」** | 基于 ~855 MB Electron 宿主的隔离 `BrowserWindow` + 分级 OS 权限（置顶/快捷键/菜单栏/按版本本地权限），聊天改代码即时热更新 | 「聊天驱动应用热更新」与分级 OS 权限模型极具参考价值 | 强绑定在线云端与 Electron 底座；VibeValley 本地优先且全原生，热更新可直接走本地 Loro CRDT |
| **Pake / Tauri (`wry`)** | Rust + macOS 系统 `WKWebView` 打出约 5–10 MB 独立 `.app` | 完全离线、可单独分发 | 只覆盖静态网页 `prototype`，丢掉原生渲染与实时协同，跨机分发受制于公证门槛 |

## Alternatives considered

- **方案 C：APFS `clonefile` 独立轻渲染进程**：安装时通过 `cp -c` 把宿主二进制零拷贝克隆进每个 `*.app`，运行时再通过回环 HTTP/SSE 连接唯一 `vibevalley-server`。虽然可绕开跨进程渲染桥，但每个打开的轻应用都会启动独立的 GPUI / Metal / `nsh` JS 引擎与字体图集进程，多开内存叠加；且宿主每次版本更新都要批量重克隆并重新签名所有已安装 `.app`；同时脱离主进程后无法共享同一套内存级文档/像素缓存。因此不作为主方案，仅在 B1/B2 跨进程渲染 PoC 遇阻时作为明确降级备选。
- **方案 A：薄壳 URL/IPC 唤醒主进程开独立窗**：每个 `*.app` 仅放最小启动器，通过 `vibevalley://artifact/<id>` 或 Unix socket 通知已运行的主进程打开去侧栏独立 `NSWindow` 后即退出。工程成本最低，但窗口归属主程序进程，无法获得独立 Dock 运行图标、`Cmd+Tab` 单独切换、独立菜单栏应用名及独立系统通知归属，达不到「独立桌面轻应用」的产品体验。
- **直接复用 `WKWebView` 独立离线打包（Pake 路线）**：仅对 `prototype` 有效，会失去其余 11 类 `ArtifactType` 的原生展示编辑能力以及 Loro CRDT / Agent 实时联动；未来若有跨设备分享 `prototype` 的需求，可作为补充「导出离线包」功能，不替代本提案。
- **复刻完整的 Chromium 全量 `remote_cocoa`**：Chromium 为支撑上百种 Cocoa 控件与多进程插件写了上万行跨进程桥；VibeValley 宿主内部已用 GPUI 统一自绘几乎全部交互元素，无需全盘照搬复杂桥接层，仅需覆写窗口、输入法与 `prototype` WebView 三个窄面。

## Acceptance criteria

1. **Stage 0 PoC 达标**：在隔离分支中可验证单台宿主进程将 GPUI 独立视图通过公开 `IOSurface` 零拷贝渲染到独立的 `vibevalley-shim` `NSWindow`（HiDPI 清晰、60fps 流畅滚动），且键盘、鼠标与中文输入法候选框定位均正常。
2. **原生系统身份完整**：在 `~/Applications/VibeValley Apps/` 生成的 `.app` 具备独立 `CFBundleIdentifier`（`dev.vibevalley.applet.<artifact_id>`）与 `.icns` 图标，支持 Spotlight 搜索秒开、Dock 独立驻留（Keep in Dock）、`Cmd+Tab` 独立切换与独立应用菜单栏名称。
3. **单宿主联动与热更新**：同时打开 3 个以上已安装轻应用时，后台仅存在 1 个 `vibevalley-server` 与 1 个重型 GPUI/Loro 宿主进程；主工作台或 Agent 修改对应 Artifact 后，桌面轻应用 1 秒内实时刷新。
4. **冷启动唤醒与生命周期干净**：宿主未运行时双击轻应用可静默唤醒宿主并打开目标作品；关闭轻应用窗口后不破坏主工作台状态，重新打开稳定复用。
5. **安装与卸载边界安全**：安装包采用一次性 `Info.plist` + ad-hoc `codesign --force --sign -` + `lsregister -f`，运行时零修改包内文件；卸载逻辑与 `CommandLine::remove` 一样严格校验标识前缀后清理，只移除自身安装项并保留作品本体数据。

## Risks

- **GPUI 离屏 Metal `IOSurface` 接缝改造成本**：GPUI 当前渲染管线围绕直连窗口 `CAMetalLayer` 构建，Stage 0 必须先验证把渲染目标拆为离屏 `IOSurface`（或走 B2 的 `CAContext`/`CALayerHost`）所需补丁范围；若发现上游修改面过大，应在 Stage 0 评审后决定转入 B2 还是降级回方案 C。
- **`CAContext` / `CALayerHost` 半私有 API 风险**：若最终采用 B2，需隔离在窄 FFI 模块中明确声明私有符号边界，并留意 macOS 大版本更新后的行为回归与 App Sandbox 兼容性。
- **中文输入法与辅助功能细节**：跨进程场景下 `NSTextInputClient` 的光标选区矩形坐标与剪贴板/拖放容易出现偏差，必须作为 PoC 显性验收项尽早覆盖。
- **`prototype` `<WebView>` 混合渲染边界**：`prototype` 内嵌 `WKWebView` 与 GPUI 窗口混排时可能引发层级或焦点竞争，按「`prototype` 直接由 Shim 内置沙箱 `WKWebView` 承载、其余 11 类走宿主跨进程图面」分流后可将复杂度压到最低。
- **多渠道并存时的宿主发现**：VibeValley 存在 `release` / `beta` / `alpha` / `dev` 多通道（各自 `server.json` 与 `BundleId`），安装器必须在 `Info.plist` 中固化安装来源通道（`VVChannel` / `VVHostBundleId`），避免跨通道错连。
