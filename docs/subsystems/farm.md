# 农场的皮

像素农场（`apps/mac/src/pixel`）是原生应用里从 `StateFrame` 画出来的像素小院，每个仓库对应一座岛与一座院子。农场把工单画成地块、帮工画成小动物，只读服务端的状态；每个场景是把一帧算成一张 `DrawList` 的普通 Rust，由 GPUI 画到窗口上，同一张也能在 CPU 上画成 PNG 来查。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 384×256 的像素村、整数倍缩放裁边、LDtk 地图、A* 寻路、昼夜天色 | 地块庄稼与木牌状态的计算（`crates/core/src/game.rs` 的 `plot_of`，[游戏](docs/subsystems/game.md)） |
| 帮工在院子里的去处（`Whereabouts`）、朝向、姿势与 800ms 最短保持时间 | 帮工真实阶段与工单状态流转（[帮工](docs/subsystems/session.md)、[工单](docs/subsystems/issue.md)） |
| 仓库群岛地图、记忆树、开场、图鉴的贴图书架 | 哪些事项进 Inbox（[收件箱](docs/subsystems/core.md#收件箱)）、像素渲染（[像素渲染与光影](docs/design/04-motion-and-pixel-rendering.md)）与工作台各页（[桌面架构与页面清单](docs/design/06-desktop-architecture-and-topology.md)） |
| 点地块、院内建筑、岛屿时去哪一页或开哪个终端（`PixelEvent`） | 窗口、标签页和工作台的路由（[客户端](docs/subsystems/app.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/mac/src/pixel/view.rs` | `PixelView`：一个像素窗格，收状态帧、走时钟、把点按变成 `PixelEvent`（去工作台的路由、换场景、开终端） |
| `apps/mac/src/pixel/draw.rs`、`element.rs` | `DrawList`（贴图、矩形、光晕，加上叠在上面的字和框）；GPUI 的绘制（最近邻重采样到整设备像素，按尺寸缓存）；`raster` 在 CPU 上画同一张 |
| `apps/mac/src/pixel/atlas.rs`、`level.rs` | 贴图尺寸和脚底锚点、LDtk 地图的可走格子与物件 |
| `apps/mac/src/pixel/farm/frame.rs` | 场景读的那部分 `StateFrame`，宽松解码 |
| `apps/mac/src/pixel/farm/world.rs` | 院子的地点和规则：9 块地 `BEDS`、院内建筑 `YARD_PLACES`、去处 `place_of_action`、`Whereabouts`、姿势 `pose_of` 与 `PoseHold` |
| `apps/mac/src/pixel/farm/scene.rs` | `FarmScene`：照最新一帧画村子并让它一直动，按可见像素和深度识别点到的物件；六把农具 `FarmTool` |
| `apps/mac/src/pixel/farm/hud.rs`、`apps/mac/ui/farm/PhoneGames.tsx` | 农场 HUD 将手机放在按钮上方，手机的五个小游戏由 nsh 绘制，按键和十字键共用输入 |
| `apps/mac/src/pixel/farm/islands.rs` | 仓库群岛地图：规则 `islands_of`、`plots_in`，画面 `MapScene` |
| `apps/mac/src/pixel/nav.rs`、`sky.rs` | 网格 A* 与沿路走的 `Walker`；日钟 `DayClock`、天色、整像素取景 `frame_whole` |
| `apps/mac/src/pixel/tree.rs`、`opening.rs`、`catalog.rs` | 记忆树、开场、图鉴的贴图书架 |
| `apps/mac/ui/features/catalog/` | 图鉴页（`/catalog`）：书架的分法 `shelves.ts`，指针和音效两个书架 |
| `apps/mac/ui/design/pixel/` | 工作台里的像素零件：贴图图标、农机 logo、音效配方 `sound.ts` 与离线合成 `synth.ts` |

## 模型和不变量

仓库页的「群岛」打开地图（`/map`）。点岛进入该仓库的农场。点有工单的地块打开工单，按 Escape 回到群岛。点空地块创建工单，表单会选中该仓库。点取消或成功保存后回到群岛。有工作目录的地块和岛面都能右击打开终端，分别进入帮工目录和仓库目录。

- **一个仓库一座院子，皮里无第二份业务状态**：场景只留画面要的东西（坐标、走到哪、选中的农具），帮工与地块每帧从 `StateFrame` 取。
- **一块地对应一张工单（`plot_key_of`）**：9 块地前 6 块对应并发槽位 `station` 0–5，后 3 块在 Lv.5、Lv.8、Lv.12 解锁为装饰花坛；庄稼与木牌由服务端的 `plot_of` 按工单 `stage` 算出：

| 工单阶段（`Issue.stage`） | 庄稼贴图（`Crop`） | 木牌提示 |
|---|---|---|
| `working`（刚到场 / 未改文件 / 已改文件 / 已跑命令） | `seeded` / `sprout` / `leafy` / `flowering` | 模型重试时显示「重试中」 |
| `working`（修复打回的验收意见） | `weeds`（杂草） | `除草中 N` |
| `asking`（等你回答） | `dry`（干裂） | `等你回答` |
| `reviewing`（等你验收 / 助手已验过） | `flowering` / 成熟作物 | `等你验收` / `可收获` |
| `stuck`（`conflict` / `failed` / `interrupted` / `quiet`） | `withered`（枯萎）/ 原样 / `dry` | `有冲突` / `有虫` / `停在半路` / `没动静` |

- **走位与姿势由当前动作驱动（`world.rs`）**：
  - 读、搜文件去书屋，跑命令与 MCP 去工坊，查网页去电台，等待坐长椅，其余留在地边（`place_of_action`）；庄稼成熟、干裂或枯萎时回到地块旁（`spots_for`）。
  - 步行动作按帮工走过的距离取帧。到达书屋后打开书阅读，到达工坊后挥锤，改文件时在自己的田里挥锄。等用户回答时帮工收起工具、举手；长时间没动静或运行失败时显示担忧。
  - 换去处要目标维持 1.2 秒且原地待满 2 秒才动身（`Whereabouts::SETTLE`、`DWELL`），急的立即走；每个姿势至少保持 800ms（`POSE_MIN_S`）。
- **384×256 逻辑网格加整数倍缩放裁边（`sky.rs` 的 `frame_whole`）**：
  - 2 倍密贴图按密度映射回逻辑坐标（`atlas.rs`）。
  - 画面只取整数倍缩放，农场左右每边最多裁 5%、上下最多裁 8%（`FARM_CUT`）。
- **像素保持锐利**：GPUI 采样是线性的，所以每张图先在 CPU 上最近邻重采样到它盖住的设备像素再 1:1 画（`element.rs`）。
- **六把农具对应数字键 1–6**（`FarmTool`）：手、浇水、捉虫、除草、收获、铲子。捉虫、铲子只执行服务端 `Issue.stage.acts` 给出的重试或叫停；点有待回答工单的地块，在农场面板选答案或输入回复。收获面板用用户看到的文件树版本审查并完成工单。若树已变化，面板保留工单并列出新增差异。一次只发一条命令，失败显示服务端原因，成功后才亮地块。
- **悬浮与未读提示**：鼠标指向地块或地上的帮工时，卡片显示作物、仓库和所选农具当前能做的事。服务端未提供动作时，卡片显示原因。频道按钮的未读数随频道状态更新；手机角标优先显示未接来电。
- **HUD 按窗格定位**：工具栏和树的文字不随像素村裁边；窄窗导航分两行，文字裁切，面板分页，打开面板时挡住背后的地块点击。夜间乘色只作用于地面和角色，灯光与 HUD 保持自己的颜色。
- **帮工外观来自档案**：进农场和打开面板时读 `agent.list`，动物与服装在下一帧更新；没有配置或素材时用现有的农夫贴图。
- **田头和农场日志读频道**：田头列未归档的频道，日志包含串，显示最近一条话与未读数；点一行打开对应的聊天页，编辑器、输入法与发言沿用工作台。仓库面板列当前仓库工单，成就面板读服务端成就与进度。小摊只显示金币和未开张提示。
- **像素手机**：点手机或按 P 开合。从「游戏」打开方块、推箱子、小恐龙、贪吃虫或种田 2048。方向键对应十字键，空格、Enter 或 Z 对应 A，X 对应 B。点屏幕上沿的「农场通」返回游戏目录。棋盘与最高分按各游戏规则保留在本次农场页面内。
- **院内建筑即入口（`YARD_PLACES`）**：「工单」去 `/issues`，「档案」去 `/agents`，「工坊」去 `/runtimes`，「书屋」去 `/settings/skills`，点助手去 `/chat`；「小摊」「仓库」「任务与成就」「农场日志」是农场自己的面板。
- **一座岛对应一个仓库。** 地图在仓库列表或业务帧变化时重算地块。动画帧只更新时间。[群岛场景](apps/mac/src/pixel/farm/islands.rs)
- **音效没有音频文件**：配方在 `apps/mac/ui/design/pixel/sound.ts`，每次播放由 `synth.ts` 把配方合成一段 WAV，交宿主播放（`host.playAudio`）。

## 怎么走

**画一帧**

1. `PixelView` 收到 `StateFrame`，`farm/frame.rs` 解出在场的帮工、工单和 `view.plots`。
2. `FarmScene::tick` 算每个帮工的目标地点与姿势，沿网格 A* 的路逐帧走。
3. `FarmScene::draw` 按脚底 y 坐标排序出一张 `DrawList`；`element.rs` 把它画进窗格，叠上字和框。

## 和谁打交道

- **核心状态与游戏（`core`、`game`）**：读 `StateFrame` 的 `state`、`view`。
- **外壳（`apps/mac/src/shell/host_bridge.rs`）**：`PixelEvent` 交给 `Shell::on_pixel_event`，由它开工作台的页、换像素场景或开终端。
- **素材流水线**：`design/pixel/` 处理贴图并导出到 `assets/pixel/`，图集从 `sprites.json` 读取尺寸和脚底锚点（`VIBEVALLEY_ASSETS` 可以指定整组素材的位置）；`vibevalley-pixel` 在 CPU 上完成最近邻缩放、法线图推导与昼夜灯光合成。

## 为什么这样

- **用农场隐喻承载异步协作状态**：发芽、开花、干裂缺水、杂草、长虫和收获直观映射异步 agent 的等待与验收状态。
- **场景只管画，所有业务真相留在服务端**：不在客户端维护第二份帮工状态树；表单、输入法和长文字留给工作台的页面，农场点一下就过去。
- **场景先算成 `DrawList` 再画**：画面是数据，测试不用屏幕就能把它画成 PNG、数里面有什么。
- **2 倍密贴图配固定逻辑坐标，整数倍缩放保证像素锐利**：逻辑层永远按 384×256 网格计算，整数倍缩放消除像素闪烁。

## 还没做的

- 商店用金币购买装饰与工单种子、每日任务：[商店与每日任务](.agents/notes/proposed/feature/2026-10-09-shop-and-daily-tasks.md)。

## 怎么验证

- `apps/mac/src/pixel/tests.rs`（`vp run rust:check` 里）：用真的素材和 `crates/server/fixtures/farm` 的样例帧画农场、地图、记忆树、开场和图鉴；设 `VIBEVALLEY_PIXEL_OUT=<目录>` 把每个场景在 CPU 上画出的 PNG 写进去看。
- 在真的应用上：照 [验收的应用分册](.agents/skills/vv-acceptance/references/app.md)，脚本里用 `pixel:<场景>` 打开、`pixel_tap` 点、`shot` 截图。
