# 客户端

VibeValley 只有一份 Solid 2 页面（`apps/web`），由服务端在 `/` 提供，共用于桌面壳、浏览器和手机壳。页面只读服务端推送的 `StateFrame` 与查询接口，经 `VibeValleyApi` 发命令，经 `@vibevalley/protocol/host` 注入宿主能力。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 状态流连接、心跳超时重连与断线提示 | `StateFrame` 的折叠与拼装（[核心状态](docs/subsystems/core.md)） |
| 页面单向分层、Atom 状态中间层、乐观意图（`Intent`）与本地存储 | 协议形状与接口定义（[地基](docs/subsystems/foundation.md)） |
| 工作台路由、外框、浅色/深色主题与组件故事查看器（`packages/stories`） | 像素农场画布玩法（[农场的皮](docs/subsystems/farm.md)）与各页细节（[界面清单](docs/reference/farm-ui.md)） |
| 宿主契约（`host.ts`）：通知、托盘、快捷键、原生通话与标题栏避让 | 「连接到本机」服务端鉴权（[连接到本机](docs/subsystems/lan.md)）与声网令牌（[语音](docs/subsystems/voice.md)） |
| 桌面壳：服务端子进程管理、灵动岛（`apps/island`）、四发布渠道隔离、打包与自更新 | 服务端内部启动与租约（[地基](docs/subsystems/foundation.md)） |
| 手机壳：扫码配对、系统钥匙串、WebView 容器与锁屏原生通话 | |

包级说明见 [apps/web/README.md](apps/web/README.md)、[apps/web/src/farm/README.md](apps/web/src/farm/README.md) 和 [apps/mobile/README.md](apps/mobile/README.md)。

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/web/src/base/` | 纯工具层：格式化、排序、拼音搜索（`search.ts`）、中文标点转换（`typedMarks.ts`）、快捷键 |
| `apps/web/src/infra/` | 外部通信层：`frame.ts`（状态流）、`live.ts`（窄流）、`gateway.ts`（RPC WebSocket）、`query.ts`、`host.ts`、`router.ts` |
| `apps/web/src/state/` | 状态中间层：`atom.ts`（`AtomRegistry`）、`intent.ts`（乐观意图）、`stored.ts`（`localStorage` 门面）、`prefs.ts` |
| `apps/web/src/ui/`、`ui/pixel/` | 基于 `@vibevalley/base-ui` 的无样式组件封装、线条图标（`icons.ts`）与像素通用组件 |
| `apps/web/src/features/<概念>/` | 按概念划分的业务模块，跨 feature 仅经 `index.ts` 导入且无环（`src/layers.test.ts` 检查） |
| `apps/web/src/farm/`、`tree/` | 像素农场与记忆树皮肤层 |
| `apps/web/src/app/` | 顶层路由表（`App.tsx`）、侧栏导航（`places.ts`）与外框（`Shell.tsx`） |
| `packages/stories/`、`apps/web/src/stories.tsx` | 按「设计体系 / 组件 / 交互 / 界面」四层组织的组件故事查看器 |
| `packages/protocol/src/host.ts` | `Host` 接口、`desktopBridge`、`mobileBridge` 与 `desktopControl` 契约 |
| `apps/desktop/src/`、`apps/island/` | Electron 主进程（`main.ts`、`server.ts`、`channel.ts`、`update.ts`）与 macOS 原生灵动岛 |
| `apps/mobile/src/` | Expo 手机壳（`farm.ts`、`PairScreen.tsx`、`FarmScreen.tsx`、`rtc.ts`） |

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
- **远端浏览器先拿钥匙**：非回环地址打开页面时先问 `user.get`（钥匙可能在 HttpOnly 的 Cookie 里，页面读不到）；没有钥匙的，设过密码就去 `/login`，没设去 `/pair`（`features/user/entry.ts`）。配对把钥匙写进 `SameSite=Strict` 的 cookie，登录由门写进 HttpOnly 的 cookie（[连接到本机](docs/subsystems/lan.md)）。
- **手机壳单连接串行切换**：`FarmConnection` 串行管理农场选择与系统钥匙串写入，切农场时取消在途入线；手机通话走原生声网 SDK（`apps/mobile/src/infra/rtc.ts`）保持锁屏不断线。

### 发布渠道

桌面版按构建版本拆分为四个独立渠道（`apps/desktop/src/base/channel.ts`），可同机并排运行：

| 渠道 | 版本形态 | 应用名 / Bundle ID | 家目录 | 工作目录 | CLI 命令 |
|---|---|---|---|---|---|
| 正式版（`stable`） | `v0.4.0` | VibeValley / `dev.vibevalley.app` | `~/.vibevalley` | `~/vibevalley` | `vibevalley` |
| Beta（`beta`） | `v0.4.0-beta.1` | VibeValley Beta / `dev.vibevalley.app.beta` | `~/.vibevalley-beta` | `~/vibevalley-beta` | `vibevalley-beta` |
| Alpha（`alpha`） | `v0.4.0-alpha.1` | VibeValley Alpha / `dev.vibevalley.app.alpha` | `~/.vibevalley-alpha` | `~/vibevalley-alpha` | `vibevalley-alpha` |
| 开发（`dev`） | `0.0.0` / 源码 | VibeValley Dev / `dev.vibevalley.app.dev` | `~/.vibevalley-dev` | `~/vibevalley-dev` | `vp run cli` |

- **渠道独立隔离，机器级资源抢占**：各渠道有独立的单实例锁、家目录、工作目录和相隔 10 的默认端口；全局快捷键与灵动岛归先启动的渠道持有（`apps/desktop/src/infra/machine.ts`）。
- **发版阶段与表结构锁死**：
  - `alpha` 在 `main` 打 tag；首个 `beta` 从 `main` 切出 `release/X.Y` 分支。
  - 同一条 `X.Y` 线的后续 `beta` 与 `stable` 必须保持 `db.schema` 与 `beta.1` 一致（`vp run release:verify` 检查），且 `stable` 与最后一个 `beta` 指向同一提交。
- **桌面端内置 CLI 与控制 socket**：应用内「关于」页可将 `Contents/Resources/bin/<命令>` 软链到 `~/.local/bin`。主进程监听 `$VIBEVALLEY_HOME/desktop.sock`（`0600`），供 `vibevalley app status|open|quit|restart|update` 控制桌面端。

## 怎么走

**桌面端启动与退出**

1. Electron 获取本渠道单实例锁，在同一个窗口上方用沙箱化的 `WebContentsView` 展示静态加载页 `opening.html`，文档和字体加载后显示窗口。它与浏览器首屏共用三张无字开机场景（`public/brand/opening-*.webp`），按本机时间选择：5–10 点晨光山谷、10–18 点门口迎宾、其余时间夜间灯火。品牌名、加载状态和失败原因由页面单独绘制；中文开屏名为「码农谷物语」，英文为「VibeValley」。
2. 读取缓存的登录 shell `PATH`，并发启动服务端子进程（传入 `VIBEVALLEY_PORT=0 --ready-json --web <页面目录>`）。
3. 等待服务端 stdout 输出 JSON 就绪收据（限时 40 秒），在开屏下面加载它的网页，不替换开屏文档。网页通过 `Host.opening` 上报真实阶段，隐藏自己的内联开屏；场景、字体和进度保留到同一次退场。服务启动失败时在原开屏展示原因与日志路径，不重新加载。整页刷新重新开屏，应用内导航不重播。
4. 启动 `VibeValleyIsland` 子进程，主进程订阅 `/api/v1/state` 将工单摘要推给灵动岛 stdin，点击条目经 stdout 打开对应工单。
5. 退出时先向服务端发 `SIGTERM` 等待落盘（限时 8 秒，超时 `SIGKILL`），关闭灵动岛并释放快捷键。

品牌名、像素进度条、芽叶精灵与状态文字集中在底部。等待真实进度时，显示进度从 3% 平滑前进，模拟部分最多到 90%；真实阶段超过它后接着前进，始终不后退。模拟值只用于显示，不改写真实进度或就绪状态。10%、30%、50%、70% 是启动阶段的权重，不是耗时比例；图片完成数推进 50–70%，画布的资源比例推进 70–95%，全部就绪才到 100%。失败或超时立即停止模拟，不假报完成。精灵跟随进度显示认真、期待和开心，超时或失败显示困惑。减少动效时停止循环和精灵位移，只低频更新进度。

开机图在工作台取得首帧和首批查询后退场，最多等待 2 秒；农场另等画布画好或报错，最多再等 15 秒。画布经 `data-opening` 与 `data-opening-progress` 声明等待、失败和资源比例，开屏不导入农场模块。超时、画布失败或活跃的初始查询失败都不报完成，交回页面自身的等待或错误状态；订阅、观察器和计时器在等待结束或根作用域取消时释放。桌面原生开屏退场或窗口关闭时移除并关闭自己的 `webContents`，不替换主网页及其宿主桥。查询活动与失败通过根作用域的 Query client 读取，不另建全局缓存。完成跳跃与 240 毫秒退场同时发生，不额外停留。没有「开始／继续」菜单，第一次打开同样直接进入应用。

**工作台路由**

- `/` 打开默认页（`/chat` 或设备偏好的农场页），`/farm` 与 `/farm/<仓库>` 打开像素农场，`/pair` 为局域网配对页。
- `Shell` 外框包含农场和 `/chat`、`/issues`、`/artifacts`、`/pkm`、`/agents`、`/runtimes`、`/repos`、`/catalog`、`/settings`。农场保留侧栏，不显示工作台页头；`/tree` 和 `/pair` 在外框之外。
- `infra/router.ts` 提供 Router、对象路由表与 Outlet。共同布局跨页面保留，参数变化保留页面实例，需要重建的农场按仓库显式设 key。应用布局读 route meta，不自行拆 URL。匹配、History、参数与查询字符串的约定见 [Router](apps/web/src/infra/router/README.md)。
- URL 查询字段只经 Router 更新；工单筛选由 Schema 读写，不再由 Atom 另存。未知页面、非法站内编码和不满足 Codec 的参数显示错误页，不默默跳到可写页面。
- 无样式的 Query、Router、Form、Table 归 `infra`，数据契约使用 Zod；视觉绑定归 `ui`。Form 管编辑版本、校验与明确的提交收据；Table 消费已解码的领域行，不拥有请求。字段、生命周期和受控状态的契约见 [页面基础设施](apps/web/src/infra/README.md)。

**打包与自更新**

1. `vp run package:mac` 构建页面与桌面壳，用 `pnpm deploy --prod` 和 `vp pack` 打包服务端，产出 `.dmg`、`.zip` 与 `release.json`。
2. 打包应用启动时及每 4 小时检查同渠道最新 Release，下载 `.zip` 并校验大小、SHA-512 与 `Info.plist` 版本。
3. 若新版本 `dbSchema` 与本地一致，退出或点「重启更新」时自动替换 `.app`；若 `dbSchema` 变化，仅在「关于」页由用户确认后替换。
4. 点「重启更新」后，窗口盖上开场的农场画面（`opening.html`），按步说：停下帮工、存好农场，再换上新版本；新版本打开时还是这幅画面。换不上时画面留着，说原因并给出 Release 页的链接「去下载最新版」。

## 和谁打交道

- **服务端（`http/app.ts`）**：通过 `--ready-json` 交接监听地址，在 `/` 提供静态页，在 `/api/v1/*` 提供接口与流。
- **「连接到本机」（`lan`）**：向局域网设备提供同一份页面与配对页 `/pair`。
- **宿主桥（`@vibevalley/bridge`）**：连接页面与 Electron 主进程、Expo 原生壳及 CLI 控制通道。

## 为什么这样

- **一份 Solid 2 页面服务三个宿主**：UI 与纯函数规则只写一遍，按 id `reconcile` 细粒度更新，避免高频帧触发整树重渲染。
- **状态中间层收拢到 `state/atom.ts` 的 Atom，意图按帧 `seq` 结算**：消除「请求返回先弹回旧状态、下一帧再跳过去」的闪烁。
- **按概念分 feature，单向分层且出口显式**：跨 feature 只走 `index.ts` 并禁止成环；像素农场作为皮肤层放在 `features` 之上。
- **四渠道完全隔离并自带 CLI**：正式版与开发版/测试版可同机并排运行，互不争抢库，用户无需另装 Node 即可使用 CLI。

## 还没做的

- 手机竖屏专属版面：[手机竖屏版面](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)。
- 状态流按实体增量推送：[页面的连接接着带上在线状态和工单的增量](.agents/notes/proposed/architecture/2026-10-27-presence-and-entity-deltas.md)。
- 页面关闭时的移动推送、Windows 桌面版、macOS Developer ID 签名与公证。

## 怎么验证

- `vp run web:check`、`vp test run apps/web/src/layers.test.ts apps/web/src/stories.test.ts`：页面类型、Tailwind 的编译、令牌/门禁规则（`vibevalley/style-attrs`、`vibevalley/no-hex-color`、`vibevalley/design-tokens`）、分层方向与故事覆盖测试。
- `vp run --filter @vibevalley/web e2e`（`apps/web/test/*.spec.ts`）：各页面 Playwright 端到端与 axe 无障碍测试。
- `vp run desktop:test`、`apps/desktop/src/base/releases.test.ts`、`vp run --filter @vibevalley/desktop update-check`：桌面端启动、灵动岛、渠道版本与自更新测试。
