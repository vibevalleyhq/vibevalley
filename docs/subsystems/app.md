# 客户端

VibeValley 的客户端是一个原生 macOS 应用 `apps/mac`（二进制 `vibevalley-mac`）：GPUI 的窗口，里面带着服务端；工作台的页面是 nsh 跑的 TSX（`apps/mac/ui`），像素农场、地图、记忆树、开场和图鉴由 Rust 直接画（`apps/mac/src/pixel`）。页面只读服务端推来的 `StateFrame` 与查询接口，经进程内的桥发命令，不经 HTTP。没有浏览器页面、Electron 桌面版和手机壳，只支持 macOS（[原生计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)）。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 窗口外壳：项目栏、侧栏（文件、源码管理）、分栏和标签页、终端、文件和 diff 查看、命令面板、主题和字号 | `StateFrame` 的折叠与拼装（[核心状态](docs/subsystems/core.md)） |
| 在进程里起服务端，放出本机回环的 HTTP 门，写 `server.json` | 服务端内部的组装（[地基](docs/subsystems/foundation.md)） |
| 页面和服务端之间的桥：调用、状态帧、事件、订阅 | 协议形状与接口定义（[地基](docs/subsystems/foundation.md#契约规则和数据库)） |
| 工作台：路由、外框、页面的分层、乐观意图与本机存下的选择、浅色和深色主题 | 各页的细节（[界面清单](docs/reference/farm-ui.md)）、界面怎么做（[界面](docs/style/design.md)） |
| 宿主能力（`host.*`）：通知、主题、语言、打开文件和网址、终端、播放声音 | 像素场景画什么（[农场的皮](docs/subsystems/farm.md)） |
|  | 命令行（`crates/vibevalley-cli`，[开发](docs/development.md#只用命令行派一个活)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/mac/src/main.rs`、`shell.rs`、`panes.rs` | 开窗口；根视图 `Shell`：项目、每个项目的分栏布局、侧栏、命令面板、快捷键（`bind_keys`） |
| `apps/mac/src/hosted/` | 托管视图：一个视图一个 nsh 引擎，跑同一份 TSX 包；`bridge.rs` 是页面发回来的动作（`Action`），`frames.rs` 是外壳推给侧栏和面板的帧，`late.rs` 让服务端在后台线程起来 |
| `apps/mac/src/host.rs` | 宿主能力的原生一半：系统通知、Finder 里显示、`open`、本地文件选择与另存、读文件 |
| `apps/mac/src/audio.rs`、`audio.m` | AVFoundation 文件播放、跳播与有界 PCM 队列；宿主音频命令按桥的接收顺序执行 |
| `apps/mac/src/command_line.rs`、`tray.rs`、`island.rs` | 命令行符号链接、菜单栏摘要、灵动岛进程与工单摘要 |
| `apps/mac/src/terminal/`、`viewer.rs`、`diff.rs` | 终端（`crates/vibevalley-terminal`）、文件查看、diff |
| `apps/mac/src/pixel/` | 像素场景：农场、地图、记忆树、开场、图鉴（[农场的皮](docs/subsystems/farm.md)） |
| `apps/mac/src/theme.rs`、`apps/mac/ui/tokens.ts` | 外壳的主题和设置；两边的值一样 |
| `apps/mac/src/debug.rs` | 不看屏幕检查应用的两个入口：状态转储和脚本（[验收](.agents/skills/vv-acceptance/references/app.md)） |
| `apps/mac/ui/App.tsx`、`bridge.ts`、`surfaces/`、`components/` | TSX 包的入口（按 `host.params.view` 挑视图）、桥的页面一半、外壳的面（侧栏、命令面板、Markdown 窗格）和它们的零件 |
| `apps/mac/ui/vv/VibeValley.tsx`、`vv/web/` | 工作台：`app/`（路由表 `App.tsx`、导航 `places.ts`、外框 `Shell.tsx`）、`features/<概念>/`、`ui/`、`state/`、`infra/`、`base/` |
| `apps/mac/ui/vv/solid.ts`、`polyfill.ts` | 工作台的页面沿用 Solid 的写法；这两个文件在 nsh 的响应式上给出它们用到的那部分 |
| `apps/mac/ui/vv/theme.json`、`apps/mac/ui/nsh.json` | 工作台的令牌：颜色（浅色、深色各一套）、字号、圆角、缓动、阴影（[界面](docs/style/design.md#令牌)） |
| `crates/vibevalley-bridge/` | 桥的 Rust 一半：`Hub` 把一个 `Server` 分给多个视图；`fake::FakeServer` 用样例状态和写好的回答顶替服务端 |
| `crates/vibevalley-workspace/`、`crates/vibevalley-store/` | 项目、布局和终端的模型，和它们存的库 |
| `packages/protocol/src/host.ts` | `Host` 接口：页面能向宿主要的东西 |
| `apps/island/` | 刘海上的灵动岛（Swift）：一个单独的小程序，stdin 收工单摘要，stdout 说点了哪一行（[apps/island/README.md](apps/island/README.md)）；`apps/mac` 从包内带起它，退出时关闭 |

## 模型和不变量

### 进程和服务端

- **服务端在应用的进程里**：`BridgeHub::install` 在后台线程调 `vibevalley_server::start`，家目录是 `$VIBEVALLEY_HOME`（默认 `~/.vibevalley`），工作目录是 `$VIBEVALLEY_WORK_ROOT`，默认 `~/vibevalley-dev`；起来之前的调用由 `LateServer` 接住。开场等待服务端、HTTP 地址公告和项目加载都成功；失败停在失败画面。
- **同一个服务端另开一道本机的 HTTP 门**：`vibevalley_http::serve` 绑 `127.0.0.1` 的空闲端口，地址写进家目录的 `server.json`；命令行据此找到它，帮工的 `/mcp` 也在这道门上。
- **一个服务端只有一个用户**：门只听 `127.0.0.1`，本机来的请求就是用户，没有登录、设备和配对。
- **外壳自己的数据另存一个库**：项目、布局、外壳的设置在 `~/Library/Application Support/VibeValley/state.db`。`VIBEVALLEY_STORE` 指定宿主库文件。宿主库名为 `state.db` 时，nsh 页面在同目录的 `nsh/` 读写。其他库名各用同目录的 `<库名>.nsh/`。服务端使用自己的家目录。 已有项目可直接激活。用户按目录打开新项目或关联终端时，宿主在后台读取项目。终端桥在标签创建或复用后返回其标识。

### 工单里的子任务

工单详情和档案的会话轨迹读取服务端的子任务摘要。每行显示任务、最近确认的状态、活动和时间。看板和工单列表也显示等待对象。等待对象与任务创建者分别显示。Codex 等待协作消息时，面板显示等待消息。若任务描述缺失，面板显示厂商提供的名称或线程标识。展开一行可看该线程报告的计划，以及该轮该线程的近期工作日志。日志只保留最近 240 步。较早的步骤移出后，页面仍保留服务端给出的任务摘要。进度连接中断时，面板显示中断时间与最后确认的状态。打开工单的轮次记录可查看以前各轮的子任务。[子任务面板](apps/mac/ui/vv/web/features/session/SubagentProgress.tsx)

工单的最近轮次带有工作目录核对标记时，看板、列表与详情从会话摘要显示核对提示。新轮执行期间，页面收起上一轮的提示。轮次记录保留历史提示。查看改动会打开该工单当前的 Git 差异。[工单详情](apps/mac/ui/vv/web/features/issue/views/IssueDetail.tsx)

从看板或列表打开工单后，按 Escape 可回到原卡片。窄窗还会恢复原卡片所在的列。

### 从工单进入终端

右击仓库岛在仓库目录打开终端；右击有帮工的地块和从工单详情进入，都使用会话的 worktree，并以工单号标识标签。再次打开同一命名入口时，若 shell 仍在该目录或子目录，工作区会聚焦原进程。明确带启动命令的入口每次开一个新标签。已经移除的目录在当前窗口显示路径和原因，用户可关闭提示，当前终端不会收到这条启动命令。

在终端中新建标签、向右或向下分屏时，宿主从 PTY 前台进程取得当前本地目录，必要时采用 shell 上报的目录。PTY 启动期间收到的键盘输入、输入法提交和粘贴按原顺序交给新 shell。切换项目保留运行中的进程；重启应用恢复原标签、目录和历史输出，启动新 shell。命名入口的工单号和目标路径存进布局，在子目录退出也能从同一张田找回原标签。[原生终端](apps/mac/src/terminal/mod.rs) · [PTY 会话](crates/vibevalley-terminal/src/lib.rs)

### 桥

页面经 nsh 的 `host.post("action", …)` 发动作，Rust 经 `HostChannel` 的事件回（`crates/vibevalley-bridge/src/lib.rs` 开头的表）：

| 页面（`apps/mac/ui/bridge.ts`） | 动作 | 回来的事件 |
|---|---|---|
| `call(op, payload)` | `call` | `reply:<id>`，契约的信封 `{ bizCode, message, data?, error? }` |
| `frame("state")` | `watch` | `frame:state`，工作台的最新状态。页面用 `applied` 确认修订号。慢窗口可跳过中间修订。 |
| `frame("live")`、`onLive(fn)` | `watch` | `frame:live`，每个事件一个 `LiveEvent` |
| `subscribe(name, payload, on, ended)` | `subscribe`、`unsubscribe` | `sub:<id>`，每个事件一次，结束一次 |
| `hostApi.<名字>` | `call`，`op` 是 `host.<名字>` | 外壳的 `Shell::host_call` 答 |

- **`call` 不抛**：失败是 `bizCode` 非 0 的信封；没有宿主或超时回 `ServiceUnavailable`。
- **工作台的请求只经 `Transport`**（`apps/mac/ui/vv/web/infra/transport.ts`）：`VibeValleyApi.over` 直接在契约信封上收发，不绕合成的 HTTP `Request`/`Response`；应用里是桥（`bridged.ts` 的 `useBridge()`），测试和故事换成自己的（`infra/fixtures.ts`）；页面的代码不直接碰 `host`。

### 页面状态与数据流

- **页面只读 `StateFrame`**：`infra/frame.ts` 从 `Transport` 收帧，交出最新的整帧；按 id 的列表用 `Each` 保住行。
- **状态中间层是 `state/`**：跨组件的状态 `defineAtom`（`atom.ts`）、本机存下的选择 `defineStored`（`stored.ts`、`prefs.ts`）、乐观意图 `defineIntent`（`intent.ts`）。
- **乐观意图等帧 `seq` 追上后结算**：`Intent` 是按 `phase` 区分的判别联合；写操作带 `requestKey` 或 `sendKey` 叠在当前帧上，等到 `frame.seq >= reply.seq` 或频道出现对应消息才结算。
- **错误是结构化的 `UiFault`**：`infra/api.ts` 的 `faultOf` 从信封里取出六位 `bizCode`、`reason`、`next`、`settings` 和由 `bizCodeMeta` 决定的 `retryable`，只挂在失败或降级的分支上。
- **一次性读取走 `infra/query.ts`**：自有的 Query client 管缓存与失效，结果先经 Schema 解码。会话轨迹经 `features/session/runs.ts` 的 `SessionLogs` 先订直播流、再读快照并按 `seq` 与 `revision` 合并。
- **按概念分 feature**：`features/<概念>/` 的名字和服务端的模块、契约的文件夹一样；路由表、导航和设置的分区以代码为准，这里不抄。

### 宿主

- **宿主接口封闭，缺的能力就是没有**：页面经 `infra/host.ts` 的 `currentHost()` 看能力在不在，不按宿主的名字分支；没有宿主时（无头的测试和故事）是只有名字的那一个。
- **外壳答的能力以 `host.info` 报的为准**（`apps/mac/src/shell.rs` 的 `host_call`）：通知、托盘摘要、语言、Finder 里显示、主题、字体和字号、开场、开终端、打开网址和文件、像素图的目录、播放声音、跳播、PCM 流、读文件、选择文件、另存和安装命令行。
- **命令行安装只管理自己的链接**：把包内 `Contents/MacOS/vibevalley` 链到 `~/.local/bin/vibevalley`，不覆盖已有文件或其他安装的链接；页面显示 PATH 是否包含这个目录。
- **音频有序、有界**：文件经 AVFoundation 播放，跳播的秒数应有限且非负；PCM 是 16-bit little-endian、8–192 kHz 的单声道或双声道。宿主命令按接收顺序执行后回包，PCM 待播放队列最多五秒，满了明确拒绝。Flash 生成由用户明确点开始后，宿主持有服务端的 SpeechClaim，按 format 和 sequence 顺序拉取；播放队列满时可取消地等待容量，done 后等真实播放耗尽再释放引擎。页面只收播放状态，离开或停止时取消尚未结束的本机任务。
- **媒体文件留在本机**：音频选择返回路径与元数据，`media.input.uploadFile` 沿媒体输入的大小、容器、内容与额度校验流式写入；`media.input.file` 读回已校验的输入路径。原生文件接口不经 HTTP 暴露。大结果播放和另存直接读取本地路径，不把整份文件搬进页面。
- **像素场景归外壳画**：`/farm`、`/farm/<仓库>` 和 `/tree` 的页面只发 `openFarm`、`openTree`，外壳在同一个位置换上像素视图；像素视图要去工作台的某一页时发 `PixelEvent::Route`，要开终端时发 `PixelEvent::Terminal`。

## 怎么走

**打开**

1. `main.rs` 开窗口，建 `Shell`；`Shell` 先盖上开场的像素画（`opening:launch`，`VIBEVALLEY_NO_OPENING=1` 跳过），同时在后台读项目和设置、起服务端。
2. 项目读进来后开场说「好了」，约 0.9 秒后让开；读不进来时开场停在失败上，说原因。
3. 工作台的视图以 `route` 和 `globalShell` 两个参数打开，路由变了发 `global_route` 告诉外壳。

**构建 TSX 包**

1. `apps/mac/build.rs` 用 nsh 的命令行（`NSH_BIN`、仓库的 `.tools/bin/nsh` 或 `PATH` 里的）把 `apps/mac/ui/App.tsx` 打成一个包。
2. 调试构建从磁盘读 `apps/mac/ui/build/`，改 TSX 不用重新编译 Rust；发布构建（或设了 `VIBEVALLEY_EMBED_UI`）把包嵌进二进制。
3. 没有 nsh 时调试构建仍可通过，应用里的视图报缺包；发布构建直接失败。

### 打包和更新

`scripts/release/package.ts` 将应用（`vibevalley-mac`）、命令行（`vibevalley`）和灵动岛放进 `.app/Contents/MacOS`，素材与页面包放进 `Contents/Resources`。应用从自身包定位资源，不依赖构建仓库的位置；`release.json` 记录版本、架构、ZIP 文件名、字节数和 SHA-512。

`apps/mac/src/update` 只在打包版本上启动更新检查，启动时和每四小时各检查一次。稳定版读最新正式版，alpha、beta 各读同阶段最新版本；仓库运行和 `0.0.0` 不自动检查。`VIBEVALLEY_UPDATE_FEED=off` 关闭检查，指定清单 URL 可验证本地更新。

更新包的大小、哈希、归档路径、版本和签名全部通过后才进入 ready；Developer ID 应用只接受同一团队签名。DMG、系统转移位置或不可写目录要求手工安装。更新先复制到应用旁边，退出后由独立进程替换；移动新包失败时恢复原包。页面的立即安装会重启，普通退出只替换；原包保留在同目录的 `.VibeValley-previous-<pid>.app`。更新不移动或迁移用户数据。

## 和谁打交道

- **服务端（`crates/vibevalley-server`、`crates/vibevalley-server-api`）**：进程内经 `Server` 调接口、读帧和事件；同一个 `Hub` 也挂在 HTTP 门上。
- **命令行（`crates/vibevalley-cli`）**：经 `server.json` 找到应用里的服务端。

## 为什么这样

- **服务端在进程里，页面走桥**：少一个进程和一层序列化之外的网络；HTTP 门只为命令行和帮工的 `/mcp` 留着。
- **工作台用 TSX，像素场景用 Rust**：工作台是表单、列表和文字，沿用页面的写法和契约的 TS 类型最省；像素场景要逐像素对齐和每帧重画，直接画成 `DrawList`，同一份还能在 CPU 上画成 PNG 来查。
- **状态中间层收在 `state/`，意图按帧 `seq` 结算**：消除「请求返回先弹回旧状态、下一帧再跳过去」的闪烁。
- **只做 macOS，只在本机**：浏览器、手机和另一台电脑进来的门连同登录一起去掉，主监听不用再分本机和外面。

## 还没做的

还没搬过来的页面和宿主能力，见[原生计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)的「剩下的」。

## 怎么验证

- `vp run rust:check`：`apps/mac` 和它用的 crate 的格式、clippy 与测试（`apps/mac/src/pixel/tests.rs` 用真的素材和替身服务端的样例画每个场景）。
- `vp run mac:check`：`apps/mac/ui` 的 nsh 类型检查与打包。
- `apps/mac/ui/vv/app/*.test.tsx`、`apps/mac/ui/components/*.test.tsx`：`nsh/test` 写的页面测试和截图，用样例的 `Transport`。
- 在真的应用上：照 [验收的应用分册](.agents/skills/vv-acceptance/references/app.md)，用 `VIBEVALLEY_DEBUG_SCRIPT` 走一遍并截图。
