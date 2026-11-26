# 农场的皮

农场（`apps/mac/src/diorama`）是原生应用里按独立切片（`FarmFrame` 与 `board`、`sessions`、`inbox`、`collab` 切片）画出来的 3D Papertrails 立体纸雕江南院落（`apps/mac/crates/diorama`，素材在 `assets/diorama/`）。农场把工单画成地块、帮工画成纸雕小动物偶人，只读服务端的状态。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 3D 纸雕江南庭院（`vibevalley-diorama` `wgpu` + WGSL 离屏渲染、昼夜光影、掀顶切面、射线拾取与寻路）与开场欢迎画（`OpeningView`） | 地块庄稼与木牌状态的计算（`crates/core/src/game/mod.rs` 的 `plot_of`，[游戏](docs/subsystems/game.md)） |
| 帮工在院子里的去处、朝向、动作状态与过桥路线 | 帮工真实阶段与工单状态流转（[帮工](docs/subsystems/session.md)、[工单](docs/subsystems/issue.md)） |
| 农场手机与内置小游戏（`Phone`、`FarmPhone.tsx`、`PhoneGames.tsx`） | 哪些事项进 Inbox（[收件箱](docs/subsystems/core.md#收件箱)）、纸雕渲染物理（[纸雕渲染与光影](docs/design/04-motion-and-pixel-rendering.md)）与工作台各页（[桌面架构与页面清单](docs/design/06-desktop-architecture-and-topology.md)） |
| 点地块、院内建筑时去哪一页、掀顶聚焦或开哪个终端（`DioramaEvent`） | 窗口、标签页和工作台的路由（[客户端](docs/subsystems/app.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/mac/crates/diorama/` | 跨平台纯 Rust `vibevalley-diorama`（`wgpu` + WGSL）：VVM2 网格、BC1/BC3 `.vvtex`、`DioramaWorld` 领域同步、弹簧偶人骨骼、河道/拱桥寻路、阴影/DoF 合成与射线拾取 |
| `apps/mac/src/diorama/scene.rs` | `DioramaScene`：把服务端切片映射到 `YardSnapshotSync`，管理帧缓冲池与按需节流（交互 `16ms` / 空闲 `66ms` / 切走或失活 `0 FPS`） |
| `apps/mac/src/diorama/view.rs` | `DioramaView`：场景窗格容器，异步加载场景、订阅切片、`call_with_async` 调服务端，经 `FrameSurface::paint_bgra_frame` 与 `frame_gen` 去重上传至 GPUI `DynamicTexture`，并叠放暖羊皮纸浮层控件、紧急徽章与内景聚焦栏 |
| `apps/mac/src/diorama/frame.rs` | 合并 `FarmFrame`、`BoardSlice`、`SessionsSlice`、`InboxSlice` 与 `CollabSlice` 为场景消费视图，定义 9 块地 `BEDS` 与动作去处 `place_of_action` |
| `apps/mac/src/diorama/phone.rs`、`apps/mac/ui/farm/PhoneGames.tsx` | 农场手机与 5 款内置小游戏（共用 `Phone` 状态与 `farm-phone` 浮层） |
| `apps/mac/src/diorama/opening.rs` | `OpeningView`：按本机时段解码 `assets/brand/opening-{morning,day,night}.webp` 的 Papertrails 开场欢迎画 |
| `apps/mac/src/assets.rs` | 定位应用运行时的 `assets/` 与 `assets/diorama/` 目录 |
| `design/sync-assets.sh`、`design/diorama.sh`、`assets/diorama/` | 从同级 `vibevalley-assets` 仓打包并仅同步轻量运行产物（`manifest.json`、`meshes.bin`、`lights.json`、`foley.json` 与 `print/`、`stock/` 贴图）到代码仓 |
| `apps/mac/ui/design/sound.ts`、`apps/mac/src/audio.rs` | 程序化音效触发与 Rust 侧 32 kHz 实时 WAV 合成器 |

## 模型和不变量

- **一个仓库一座院子，皮里无第二份业务状态**：场景只留画面要的东西（视角、聚焦建筑、掀顶状态、手机与面板），帮工、地块与收件箱每帧从订阅的独立切片（`farm`、`board`、`sessions`、`inbox`、`collab`）取。
- **一块地对应一张工单（`plot_key_of`）**：9 块地前 6 块对应并发槽位 `station` 0–5，后 3 块在 Lv.5、Lv.8、Lv.12 解锁为装饰花坛；庄稼与木牌由服务端的 `plot_of` 按工单 `stage` 算出，再经 `map_issue_to_plot_stage` 映射为纸雕地块阶段（`PlotStage`）：

| 工单阶段（`Issue.stage`） | 庄稼贴图（`Crop`） | 木牌提示 |
|---|---|---|
| `working`（刚到场 / 未改文件 / 已改文件 / 已跑命令） | `seeded` / `sprout` / `leafy` / `flowering` | 模型重试时显示「重试中」 |
| `working`（修复打回的验收意见） | `weeds`（杂草） | `除草中 N` |
| `asking`（等你回答） | `dry`（干裂） | `等你回答` |
| `reviewing`（等你验收 / 助手已验过） | `flowering` / 成熟作物 | `等你验收` / `可收获` |
| `stuck`（`conflict` / `failed` / `interrupted` / `quiet`） | `withered`（枯萎）/ 原样 / `dry` | `有冲突` / `有虫` / `停在半路` / `没动静` |

- **偶人走位与姿态由当前动作驱动**：
  - 读、搜文件去书屋，跑命令与 MCP 去工坊，查网页去电台，等待坐长椅，其余留在地边（`place_of_action`）；庄稼成熟、干裂或枯萎时回到地块旁。
  - 帮工偶人在院内沿河道、拱桥与石径寻路移动，配备弹簧骨骼与朝向插值。
- **昼夜光影与掀顶交互**：支持 `Dawn` / `Noon` / `Dusk` / `Night` 四档时光（快捷键 `1..4` 或 `diorama_clock` 调试命令）；点击院内建筑可聚焦并触发屋顶掀顶切面，展示内景并弹出对应入口。
- **农场面板与交互**：点有工单的地块查看详情或执行回答、重试、收获与关闭，点空地块创建工单；有工作目录的地块可右击打开终端进入帮工 worktree。
- **农场手机**：点手机或按 P 开合。从「游戏」打开方块、推箱子、小恐龙、贪吃虫或种田 2048。方向键对应十字键，空格、Enter 或 Z 对应 A，X 对应 B。点屏幕上沿的「农场通」返回游戏目录。棋盘与最高分按各游戏规则保留在本次农场页面内。
- **音效没有音频文件**：触发入口在 `apps/mac/ui/design/sound.ts`，每次播放由原生 `apps/mac/src/audio.rs` 合成器实时生成 WAV 并缓存播放（`host.playSound`）。

## 怎么走

**画一帧**

1. `DioramaView` 分别订阅 `SliceKind::Farm`、`Board`、`Sessions`、`Inbox` 与 `Collab`，`diorama/frame.rs` 合并出在场的帮工、工单、收件箱、`view.plots` 与单次特效 `effects`。
2. `DioramaScene` 由 `DioramaWorld::step` 推进偶人弹簧/过桥步态、屋顶掀顶铰链与昼夜状态，并将不可变帧输入交 `vibevalley_runtime::rt::current_or_global_handle().spawn_blocking` 异步离屏渲染，再经 `FrameSurface::paint_bgra_frame` 与 `frame_gen` 去重写入 GPUI `DynamicTexture`（失活或离开 `/farm` 时完全停帧，`0 FPS`）。

## 和谁打交道

- **核心状态与游戏（`core`、`game`）**：订阅独立 `FarmFrame`（`view`、`progress`、`effects`）以及 `board`、`sessions`、`inbox`、`collab` 切片，按需调 `game.achievement.list` 读成就与进度。
- **外壳（`apps/mac/src/shell/host_bridge.rs`）**：`DioramaEvent` 交给 `Shell::on_diorama_event`，由它开工作台的页或开终端。
- **素材流水线**：全部 3D 纸雕源资产与渲染器位于同级 `vibevalley-assets` 仓，经 `design/diorama.sh --build`（或 `design/sync-assets.sh --all`）编译并同步最小运行包至 `assets/diorama/`。同步源由 `VIBEVALLEY_ASSETS_REPO` 指定，应用查找成品的根目录由 `VIBEVALLEY_ASSETS` 指定。

## 为什么这样

- **用农场隐喻承载异步协作状态**：发芽、开花、干裂缺水、杂草、长虫和收获直观映射异步 agent 的等待与验收状态。
- **场景只管画，所有业务真相留在服务端**：不在客户端维护第二份帮工状态树；表单、输入法和长文字留给工作台的页面，农场点一下就过去。
- **全原生 Papertrails 纸雕单轨架构**：统一使用 `wgpu` + WGSL 立体纸雕与同步的 Papertrails 角色/品牌/引擎产物，不再维护双轨 2D 像素回退路径，原 2D Web 像素农场 SSIM 对照基线已随纸雕化正式退役。

## 还没做的

- 商店用金币购买装饰与工单种子、每日任务：`#46`。

## 怎么验证

- `cargo test -p vibevalley-mac -p vibevalley-diorama`（纳入 `cargo xtask check`）：覆盖 `diorama/frame.rs`、`diorama/scene.rs`、`diorama/opening.rs` 与 `vibevalley-diorama` 的映射、缓存与渲染逻辑。
- 在真的应用上：照 [验收的应用分册](.agents/skills/vv-acceptance/references/app.md)，脚本里用 `diorama:farm` 或 `hosted:vv {"route":"/farm"}` 打开、`diorama_clock` 切时段、`shot` 截图。
