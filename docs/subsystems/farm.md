# 农场的皮

像素农场（`apps/web/src/farm`）是从 `StateFrame` 渲染出的像素小院，每个仓库对应一座岛与一座院子。农场将工单画成地块、帮工画成小动物、待处理事项画成折叠屏手机来电，只读服务端状态驱动动画与合成音效。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 384×256 像素村画布、整数倍缩放裁边、LDtk 地图、A* 寻路、昼夜光照与粒子动效 | 地块庄稼与木牌状态计算（`game/view.ts` 的 `plotOf`，[游戏](docs/subsystems/game.md)） |
| 帮工在院子里的去处（`Whereabouts`）、朝向、姿势与 800ms 最短保持时间 | 帮工真实阶段与工单状态流转（[帮工](docs/subsystems/session.md)、[工单](docs/subsystems/issue.md)） |
| 快捷栏 6 把农具的指向提示（`aimTool`）与点击派发（`commands.ts`） | 农具调用的底层接口规则与播种模板填充（[工单](docs/subsystems/issue.md)、[仓库](docs/subsystems/repo.md)） |
| 仓库群岛地图（`RepoMap`）、折叠屏手机（来电、田头窗、小游戏）、合成音效与图鉴（`/catalog`） | 哪些事项进 Inbox（[Inbox](docs/subsystems/inbox.md)）与各面板详细元素（[farm-ui.md](docs/reference/farm-ui.md)） |

目录结构与画布-DOM 同步见 [apps/web/src/farm/README.md](apps/web/src/farm/README.md)。

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/web/src/farm/canvas/` | `VillageCanvas.tsx`、`scene.ts`（按脚底 y 轴排序）、`dog.ts`、`life.ts`、`fx.ts` |
| `apps/web/src/farm/world/` | `world.ts`（地点映射 `placeOfAction`、节流 `Whereabouts`、命中 `villageHitAt`、缩放 `frameVillage`）、`level.ts`、`plots.ts`、`sprites.ts` |
| `apps/web/src/farm/hud/`、`panels/`、`issue/` | 顶栏 HUD、播种袋 `SeedForms.tsx`、收成清单、仓库、成就与农场工单详情 `IssueView.tsx` |
| `apps/web/src/farm/phone/`、`chat/` | 折叠屏手机 `Phone.tsx`、来电状态 `calls.ts`、5 个纯函数小游戏 `games/*.ts`、田头聊天窗 `ChatWindow.tsx` |
| `apps/web/src/farm/map/` | 仓库群岛地图 `RepoMap.tsx` 与纯函数 `islands.ts` |
| `apps/web/src/farm/tools.ts`、`commands.ts`、`cues.ts` | 农具定义、点击命令映射与状态驱动音效 |
| `packages/engine/` | `nav`（网格 A* 寻路）、`pixi`（法线光照、天色、粒子）、`audio`（K 计权合成器）、`clock.ts`、`framing.ts` |
| `apps/web/src/features/catalog/` | 素材图鉴（读取 `public/pixel/sprites.json`、`cursors.json` 与 `ui/pixel/sound.ts`） |

## 模型和不变量

- **一个仓库一座院子，皮里无第二份业务状态**：`farmFrameOf` 按当前仓库过滤帮工与地块（顶栏等级、田头和来电仍看全农场）；坐标、已接来电与小游戏棋盘仅存当前页面内存。
- **一块地对应一张工单（`plotKeyOf`）**：9 块地前 6 块对应并发槽位 `station` 0–5，后 3 块在 Lv.5、Lv.8、Lv.12 解锁为装饰花坛；庄稼与木牌由服务端 `plotOf` 按工单 `stage` 算出：

| 工单阶段（`Issue.stage`） | 庄稼贴图（`Crop`） | 木牌提示 |
|---|---|---|
| `working`（刚到场 / 未改文件 / 已改文件 / 已跑命令） | `seeded` / `sprout` / `leafy` / `flowering` | 模型重试时显示「重试中」 |
| `working`（修复打回的验收意见） | `weeds`（杂草） | `除草中 N` |
| `asking`（等你回答） | `dry`（干裂） | `等你回答` |
| `reviewing`（等你验收 / 助手已验过） | `flowering` / 成熟作物 | `等你验收` / `可收获` |
| `stuck`（`conflict` / `failed` / `interrupted` / `quiet`） | `withered`（枯萎）/ 原样 / `dry` | `有冲突` / `有虫` / `停在半路` / `没动静` |

- **走位与姿势由当前动作驱动（`world.ts`）**：
  - 读/搜文件去书屋、跑命令与 MCP 去工坊、查网页去电台、改文件留在地边、空闲坐长椅或散步；进入待验收、受阻或提问时立即回到地块正前方。
  - 换去处需目标维持 1.2 秒且原地待满 2 秒才动身，每个姿势至少保持 800ms。
- **384×256 逻辑网格 + 整数倍缩放裁边（`frameVillage`）**：
  - 2 倍密贴图加载时自动除以密度映射回逻辑坐标。
  - 画布只取整数倍缩放，左右每边最多裁 5%、上下最多裁 8%；桌面窗口拖拽松手后自动吸附到不留黑边的尺寸。
- **农具动作完全服从 `Issue.stage.acts`**：数字键 `1–6` 切换手、浇水 `tell`、杀虫 `cure`、除草、收获 `complete`、铲除 `stop`/`close`；`aimTool` 与点击执行均实时核对最新帧的 `stage.acts`。
- **院内建筑即导航入口（`yardPlaces`）**：小摊开商店、箱子堆开仓库、告示板开任务与成就、邮筒开日志、图纸桌开 `/issues`、名册/工坊/书屋跳工作台对应页、点助手展开手机田头聊天。
- **折叠屏手机整合来电、田头与小游戏**：收起显示主屏、向右展开露出田头窗；新 Inbox 条目触发 20 秒响铃，接听即拨通助手语音电话并跳转到目标地块或频道。
- **音效按状态变化实时合成，无音频文件**：`farmCues` 对比前后状态与 `GameEffect` 触发 Web Audio 合成音效（按 K 计权响度分 -28、-24、-20 LUFS 三档）。

## 怎么走

**渲染一帧**

1. 收到 `StateFrame` 后过滤当前仓库的在场帮工，按工单 ID 查找 `view.plots` 更新每块地的庄稼与木牌。
2. 计算每个帮工的目标地点与姿势，沿网格 A* 路径逐帧移动，按脚底 y 坐标排序绘制精灵与光照，最后叠加 DOM HUD。

**空地播种（`SeedForms.tsx`）**

1. 点击空地或仓库岛空位打开播种袋，调用 `repo.template.list` 获取近期工单标题与按仓库技术栈填好验证命令的常见模板。
2. 点击「开始」向默认频道发送带仓库、档案和地块号 `station` 的消息交助手派活；点击「草稿」创建 `backlog` 工单并启动 `issue.refine` 起草。

## 和谁打交道

- **核心状态与游戏（`core`、`game`）**：消费 `StateFrame` 的 `state`、`view`、`inbox`、`effects`。
- **工单、频道与语音（`issue`、`channel`、`voice`）**：农具调 `issue.status.update` 与 `issue.comment.create`，播种与田头调 `channel.message.send`，接听来电调 `voiceCall.start`。
- **素材流水线（`design/pixel/`）**：读取 `process.py` 生成的 `public/pixel/` 贴图与 `sprites.json`。

## 为什么这样

- **用农场隐喻承载异步协作状态**：发芽、开花、干裂缺水、杂草、长虫和收获直观映射异步 agent 的等待与验收状态。
- **PixiJS 只管渲染，所有业务真相留在服务端**：不在客户端维护第二份帮工状态树，且中文输入法、无障碍和表单直接复用浏览器 DOM。
- **2 倍密贴图配固定逻辑坐标，整数倍缩放保证像素锐利**：逻辑层永远按 384×256 网格计算，整数倍缩放消除像素闪烁。

## 还没做的

- 手机竖屏专属构图：[手机竖屏版面](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)。
- 商店用金币购买装饰与工单种子、每日任务：[商店与每日任务](.agents/notes/proposed/feature/2026-10-09-shop-and-daily-tasks.md)。

## 怎么验证

- `apps/web/src/farm/world/world.test.ts`、`cues.test.ts`、`commands.test.ts`、`phone/calls.test.ts`、`phone/games/*.test.ts`：网格连通性、缩放裁边、合成音效、农具门禁、来电状态机与小游戏测试。
- `apps/web/test/farm.spec.ts`、`farm-canvas.spec.ts`、`farm-hud.spec.ts`、`farm-chat.spec.ts`、`farm-phone.spec.ts`、`farm-actions.spec.ts`：像素村渲染与交互 Playwright 验证。
