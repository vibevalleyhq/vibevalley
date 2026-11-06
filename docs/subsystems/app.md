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
- **乐观意图（`Intent`）等帧 `seq` 追上后才结算**：
  - 写操作带 `requestKey` 或 `sendKey` 叠加到当前帧上，等到 `frame.seq >= reply.seq` 或频道出现对应消息时才结算。
  - 失败意图保留在画面上供重试或放回；组件内禁止绕过 `act.run` 直接调写接口（`vibevalley/act-door` 检查）。
- **一次性读取走 `infra/query.ts`**：由 TanStack Query 管理缓存与失效，状态流重连时自动 `refetchOnRelink`。会话轨迹经 `features/session/runs.ts` 的 `SessionLogs` 先订直播流、再读快照并按 `seq` 与 `revision` 合并。
- **颜色收进语义调色板**：浅色/深色主题通过 `<html data-theme>` 切换，只用 `style.css` 语义色变量（`vibevalley/no-hex-color` 检查）；像素皮固定 `data-theme="light"`。

### 宿主与多端

- **宿主接口封闭，缺省能力为 `null`**：页面通过 `currentHost()` 检测能力是否存在，不分支判断宿主类型。跨进程调用经 `@vibevalley/bridge` 按 Schema 校验。
- **远端浏览器先配对**：非回环地址访问且无 `vibevalley_lan_key` cookie 时跳转 `/pair`；配对后写入 `SameSite=Strict` cookie（[连接到本机](docs/subsystems/lan.md)）。
- **手机壳单连接串行切换**：`FarmConnection` 串行管理农场选择与系统钥匙串写入，切农场时取消在途入线；手机通话走原生声网 SDK（`apps/mobile/src/rtc.ts`）保持锁屏不断线。

### 发布渠道

桌面版按构建版本拆分为四个独立渠道（`apps/desktop/src/channel.ts`），可同机并排运行：

| 渠道 | 版本形态 | 应用名 / Bundle ID | 家目录 | 工作目录 | CLI 命令 |
|---|---|---|---|---|---|
| 正式版（`stable`） | `v0.4.0` | VibeValley / `dev.vibevalley.app` | `~/.vibevalley` | `~/vibevalley` | `vibevalley` |
| Beta（`beta`） | `v0.4.0-beta.1` | VibeValley Beta / `dev.vibevalley.app.beta` | `~/.vibevalley-beta` | `~/vibevalley-beta` | `vibevalley-beta` |
| Alpha（`alpha`） | `v0.4.0-alpha.1` | VibeValley Alpha / `dev.vibevalley.app.alpha` | `~/.vibevalley-alpha` | `~/vibevalley-alpha` | `vibevalley-alpha` |
| 开发（`dev`） | `0.0.0` / 源码 | VibeValley Dev / `dev.vibevalley.app.dev` | `~/.vibevalley-dev` | `~/vibevalley-dev` | `vp run cli` |

- **渠道独立隔离，机器级资源抢占**：各渠道有独立的单实例锁、家目录、工作目录和相隔 10 的默认端口；全局快捷键与灵动岛归先启动的渠道持有（`apps/desktop/src/machine.ts`）。
- **发版阶段与表结构锁死**：
  - `alpha` 在 `main` 打 tag；首个 `beta` 从 `main` 切出 `release/X.Y` 分支。
  - 同一条 `X.Y` 线的后续 `beta` 与 `stable` 必须保持 `db.schema` 与 `beta.1` 一致（`vp run release:verify` 检查），且 `stable` 与最后一个 `beta` 指向同一提交。
- **桌面端内置 CLI 与控制 socket**：应用内「关于」页可将 `Contents/Resources/bin/<命令>` 软链到 `~/.local/bin`。主进程监听 `$VIBEVALLEY_HOME/desktop.sock`（`0600`），供 `vibevalley app status|open|quit|restart|update` 控制桌面端。

## 怎么走

**桌面端启动与退出**

1. Electron 获取本渠道单实例锁，立即打开窗口展示静态加载页 `opening.html`。
2. 读取缓存的登录 shell `PATH`，并发启动服务端子进程（传入 `VIBEVALLEY_PORT=0 --ready-json --web <页面目录>`）。
3. 等待服务端 stdout 输出 JSON 就绪收据（限时 40 秒），将窗口导航至该地址；若失败则在窗口展示原因与日志路径。
4. 启动 `VibeValleyIsland` 子进程，主进程订阅 `/api/v1/state` 将工单摘要推给灵动岛 stdin，点击条目经 stdout 打开对应工单。
5. 退出时先向服务端发 `SIGTERM` 等待落盘（限时 8 秒，超时 `SIGKILL`），关闭灵动岛并释放快捷键。

**工作台路由**

- `/` 打开默认页（`/chat` 或设备偏好的农场页），`/farm` 与 `/farm/<项目>` 打开像素农场，`/pair` 为局域网配对页。
- `Shell` 外框包含 `/chat`、`/issues`、`/artifacts`、`/pkm`、`/agents`、`/runtimes`、`/projects`、`/catalog`、`/settings`。

**打包与自更新**

1. `vp run package:mac` 构建页面与桌面壳，用 `pnpm deploy --prod` 和 `vp pack` 打包服务端，产出 `.dmg`、`.zip` 与 `release.json`。
2. 打包应用启动时及每 4 小时检查同渠道最新 Release，下载 `.zip` 并校验大小、SHA-512 与 `Info.plist` 版本。
3. 若新版本 `dbSchema` 与本地一致，退出或点「重启更新」时自动替换 `.app`；若 `dbSchema` 变化，仅在「关于」页由主人确认后替换。

## 和谁打交道

- **服务端（`http/app.ts`）**：通过 `--ready-json` 交接监听地址，在 `/` 提供静态页，在 `/api/v1/*` 提供接口与流。
- **「连接到本机」（`lan`）**：向局域网设备提供同一份页面与配对页 `/pair`。
- **宿主桥（`@vibevalley/bridge`）**：连接页面与 Electron 主进程、Expo 原生壳及 CLI 控制通道。

## 为什么这样

- **一份 Solid 2 页面服务三个宿主**：UI 与纯函数规则只写一遍，按 id `reconcile` 细粒度更新，避免高频帧触发整树重渲染。
- **状态中间层收拢到 Effect Atom，意图按帧 `seq` 结算**：消除「请求返回先弹回旧状态、下一帧再跳过去」的闪烁。
- **按概念分 feature，单向分层且出口显式**：跨 feature 只走 `index.ts` 并禁止成环；像素农场作为皮肤层放在 `features` 之上。
- **四渠道完全隔离并自带 CLI**：正式版与开发版/测试版可同机并排运行，互不争抢 SQLite 库，用户无需另装 Node 即可使用 CLI。

## 还没做的

- 手机竖屏专属版面：[手机竖屏版面](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)。
- 状态流按实体增量推送：[页面的连接接着带上在线状态和工单的增量](.agents/notes/proposed/architecture/2026-10-27-presence-and-entity-deltas.md)。
- 页面关闭时的移动推送、Windows 桌面版、macOS Developer ID 签名与公证。

## 怎么验证

- `vp run web:check`、`vp test run apps/web/src/layers.test.ts apps/web/src/stories.test.ts`：页面类型、分层方向与故事覆盖测试。
- `vp run --filter @vibevalley/web e2e`（`apps/web/test/*.spec.ts`）：各页面 Playwright 端到端与 axe 无障碍测试。
- `vp run desktop:test`、`apps/desktop/src/releases.test.ts`、`vp run --filter @vibevalley/desktop update-check`：桌面端启动、灵动岛、渠道版本与自更新测试。
