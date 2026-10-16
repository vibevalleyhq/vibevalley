# 像素村、素材和音效

Flutter 客户端里和 VibeValley 本身无关的那一半：把一张像素画放大到窗口、东西站在地上、角色走过去、昼夜和光、一会儿就消失的特效、合成音效，以及生图切图的流水线。像素村用 Flame 画（`app/lib/village/`），外框和首页在 `lib/shell/`（目录见 [flutter](../app/README.md)）。画面只读服务端折好的核心状态（[architecture.md](architecture.md)「核心状态」），自己只加跟着时钟走的东西：走动、闲逛、姿势、喘气、狗的一天。

## 首页

客户端打开先是首页（`lib/shell/title/`；[理由](../.agents/notes/implemented/feature/2026-10-12-title-screen-and-settings.md)），只在这台设备第一次打开时出来；进过一次农场以后，再打开直接进农场，游戏菜单的「回到首页」照旧能回去。

- **背景跟着钟点**（`scene.dart`）：5–9 点早晨（管家伸懒腰）、9–16 点白天、16–19 点半黄昏、其余是夜晚（管家提着灯，狗睡着）。四张是同一个构图：`design/pixel/gen.sh title` 画黄昏那张，`title-morning`、`title-day`、`title-night` 照它改钟点；再各画一张去掉烟囱炊烟的（`title[-钟点]-nosmoke`），炊烟由客户端画成动的。`--dart-define=VIBEVALLEY_TOD=0.9` 换钟点看。
- **动起来**（`title_stage.dart`、`layers.dart`、`motion.dart`）：底图放在保持 3:2、盖满屏幕的台子上慢慢推移；台子上按底图的像素坐标叠着会动的东西，都是 codex 单独画的（`gen.sh title-clouds title-smoke title-dandelion title-plants`，`design/pixel/title_layers.py` 去品红、按图形块切开）：云飘过，烟从烟囱一团接一团冒出来，草丛、蕨和蒲公英微微摆，种子被吹走，黄昏和夜里田上有萤火虫。各层按钟点调色。管家按钟点换姿势（`title-manager`），宠物是你选的那只（`title-dog`、`title-ragdoll`、`title-bluecat`）。
- **加载在启动时**（`startup.dart`）：连上农场、读钥匙、字体、首页的图、像素村，都好了才出首页；服务端没答应时不等，顶上的横幅说连不上，带着去「院门」的入口。

左边列三项，方向键和回车也能选：**开始游戏**（管家还没有 DeepSeek 的钥匙就先打开设置）、**继续游戏**（有农场可回时才能点）、**设置**（DeepSeek 的 API Key、Agora 的 App ID 和 App Certificate，[server.md](server.md)「设置」）。

## 像素村

农场是风来之国那样的像素画（[决定](../.agents/notes/implemented/feature/2026-10-11-pixel-village.md)），世界是 384×256 的格子，按真实像素画、整数倍放大（`lib/village/game.dart`、`village_view.dart`）。

窗口不是 3:2 时（全屏、手机、截图），农场取最大的整数倍，同时保证四边裁掉的不超过一点：左右每边至多 5%，上下每边至多 8%，那里只有崖壁、树梢和篱笆。所以 16:10 的窗口是盖满的，裁一点边；实在盖不满的窗口（比如竖着拿的手机）留边，边上垫着放大、压暗的农场（`lib/village/framing.dart`，`farm_page.dart`，[理由](../.agents/notes/implemented/feature/2026-10-15-farm-fills-the-window.md)）。桌面窗口本来就吸到整数倍（[desktop.md](desktop.md)），正好不裁也不留边。

- **地图数据在 LDtk 里**（`village.ldtk`，用 [LDtk](https://ldtk.io) 打开，`lib/village/level.dart` 直接读）：Ground 层（4 像素一格）标能走的地方；Things 层是每块地（Plot）、帮工去的地点（Place）、道具（Prop，带它开哪个面板和用哪张图）、能点的区域（Area）、闲逛的地方（Rest）、灯（Light）、大门（Gate）、排队的起点（Queue）、管家和狗，以及院子动起来的地方（Fx：烟囱、铁砧、电台天线、池塘）。地和道具的底由游戏从能走的地方里扣掉，所以挪它们不用重画 Ground。名字和说明在 `world.dart`。
- **院子不动，镜头前的植物动**：整张地图一直在画面里；最前面一层是镜头前的枝叶和草，往指针那边偏几个像素，所以有前后的感觉。
- **东西站在地上**：帮工、管家、狗和道具脚下都有影子，以脚底那条线为中心。每张图的落脚点在脚底（`design/pixel/process.py` 算好写进 `sprites.json`）。喘气、干活的起伏、管家说话时的点头，都是把身子拉高或压低一个像素；只有真的跳（被点、欢呼、狗被拍）才离开地面。
- **帮工去哪**（`world.dart`）：读、搜去书屋，跑命令和 MCP 去工坊，查网页去电台，等着坐长椅；改文件、想事情在自己的地边，用 `strolls` 换位置；地满了在排队的起点等。动作落在东西上：在地里干活时站进地里，工具落在土里；在工坊站在铁砧边一下下敲；在书屋门口捧着书读；在电台背对着我们忙；等着就坐在长椅上（`pose-*` 那几张图）。
- **寻路**（`nav.dart`；[理由](../.agents/notes/implemented/feature/2026-10-10-walking-on-paths.md)）：把能走的地方铺成格子，A* 找最省的路：靠近障碍的格子贵一点，所以走在过道中间；最后把能直走又不更贵的拐角拉直。
- **画在上面的字和 HUD**（`hud.dart`）：按屏幕像素画，字在任何缩放下都清楚。地块指着时说是什么、手上的工具点下去会怎样；帮工头上是在做什么；管家头上是他说的话；院子里的东西指着时（或按住 ⌥ 时）显示名字，平时挂一块小木牌和等着的数字。HUD 是左上的管家头像和农场状态，右上的地图、频道、精力瓶和菜单，左下的手机和帮工，下边的工具栏；它们贴着农场在窗口里露出来的那一块的边，农场盖过窗口时就贴着窗口的边。
- **入口在院子里**（`world.dart` 的 spots）：小摊是商店，箱子堆是仓库，告示板是任务与成就，邮筒是日志，图纸桌是种植计划，路牌是帮工名册，工坊是农具，书屋是技能书，管家本人是换样子和宠物。
- **地上的效果**（`fx.dart`、`particles.dart`）：浇水掉水滴、杀虫一团白雾、铲除扬土、收获时庄稼蹦出来带金屑、收进来时金币跳出来；被点的地往下沉一个像素。粒子按整像素移动。
- **院子自己的动静**（`life.dart`、`critters.dart`、`dog.dart`）：都是客户端自己画的，不是农场的状态。烟囱冒烟、白天的蝴蝶和飞过的鸟群、池塘的涟漪和跳鱼、风吹下的树叶、夜里的萤火虫；狗睡着时冒 Zzz，醒着时摇尾巴、挠痒、打哈欠。帮工在干什么，就在哪里看得出来：工坊的铁砧火星四溅，书屋飘纸页，电台天线发信号，长椅上冒 Zzz。点在院子里没人接的地方，按那里画的是什么回应（土上扬土、草上溅叶子、池塘溅水），各配一声；拍狗，它每拍一下换一个把戏。
- **光**（`sky.dart`、`normals.dart`、`pass.dart`）：每个像素按它朝哪边被照亮，不另画夜景。法线贴图在加载时从画里生成；天光是环境光加上白天的太阳、夜里的月亮，白天有云影、清晨有雾；打完光整体调色，白天偏暖、黄昏琥珀色、夜里蓝。天黑以后窗户、路灯（LDtk 的 Light）、提灯和萤火虫是点光源，自己发光的东西带一圈光晕。影子两层：一层压在脚下，一层背着太阳拉长。
- **像素密度**（[理由](../.agents/notes/implemented/architecture/2026-10-12-denser-pixels.md)）：素材画成两倍密（一个格子里 2×2 个像素），东西仍按 384×256 的格子摆；密度由地图宽除以关卡宽得出。

## 素材

素材流水线的理由见 [image-pipeline-with-codex](../.agents/notes/implemented/process/2026-10-09-image-pipeline-with-codex.md)。

1. **生图**：`design/pixel/gen.sh <名字>` 用 codex 的生图工具画，产出是品红底的整张图，在 `design/pixel/raw/`（原图在单独的仓库 vibevalley-art，先跑一次 `design/art.sh` 把它链接进来）：地图、地块、道具、精力瓶、田头的按钮、日历的地块、院子里的小动物、帮工（7 种动物 × 4 套衣服，下、上、侧三个方向的站和两步走，加干活、欢呼、发愁，和在建筑前的 `pose-*`）、管家的样子、狗和两只猫的十二个样子、农机上的 agent logo（`logos`）、地图页的六座岛（`island-<样子>`，中间留一块空的院子）和地图上的小东西（`mapbits`）。界面的几张先由 `design/assets/gen.sh` 照效果图画成手绘的原图（`design/assets/raw/`），像素版照它重画（`ui-<sheet>`），格子和名字不变。两倍密的版本由 `gen.sh hd-<名字>` 照原来那张重画（`hd_batch.sh` 一批并行）。
2. **切图**：`design/pixel/process.py` 只写「哪张图、几行几列、每格叫什么」，去品红、按格子切、缩到真实大小、压到 32 色、算落脚点，写图和 `sprites.json`（每张记着它切自哪张原图 `sheet`；图鉴页按它说怎么重画）。地块按木框对齐，画歪的线由 `straighten.py` 拉直。岛按院子缩：院子缩到 150 格宽，好放下三块并排的地，院子的位置记在 `sprites.json` 的 `yard`。改了图重跑切图，不手改 `sprites.json`。
3. **用图**：客户端按 `sprites.json` 读图（`lib/sprites/atlas.dart`）。所有图、指针、音效都能在图鉴页（`lib/desk/assets/`）里看。
4. **macOS 应用的图**：`design/pixel/gen.sh app-icon` 画应用图标，切成 macOS 的圆角方块放在 `app/macos/Runner/Assets.xcassets/AppIcon.appiconset/`；菜单栏的苗是单色模板图（`TrayTemplate.imageset`），不交给生图。
5. **指针**：`design/pixel/gen.sh ui-cursors` 照手绘的指针图重画成像素，`process.py` 切开后在 16 像素上组合变体（工具加闪光表示能用，加禁止标记表示用不上）。客户端没有图片鼠标指针：农场里的工具指针画在画面上（`lib/farm/cursors.dart`）。

## 音效

音效不是录音，是现合成的（[理由](../.agents/notes/implemented/feature/2026-10-10-synthesized-sound-effects.md)）：每个音效是一个配方，用 `Pen` 画几笔，音调（可以滑音）、滤过的噪声、铃声各有自己的起落。配方在 `lib/shell/sfx.dart`（分组和名字在 `soundGroups`、`soundLabel`），合成器在 `lib/shell/synth.dart`：

| 分组 | 音效 | 什么时候响 |
|---|---|---|
| 界面 | 点击、点不了、拿工具、展开、收起 | 点了能用的工具；点了用不上；换工具；面板、对话框开合 |
| 农具 | 浇水、杀虫、除草、收获、铲除、播种 | 对应的工具真的落到地上 |
| 地里 | 熟了、长虫、帮工到了 | 帮工做完、做砸、新雇来 |
| 奖励 | 金币、升级、成就 | 拿到奖励；一起来的时候依次响，不叠成一团 |
| 语音 | 语音接通、来电、语音挂断 | 管家接通、手机响、挂断 |
| 院子 | 草叶沙沙、扑通、踩土、狗和猫的叫声 | 点草和树、点池塘、点土；拍狗或猫 |

- **从状态里响，不从点击里响**（`lib/shell/farm_sounds.dart`）：不管是你点的、帮工做的、服务器推的还是调试台改的，状态变了就响。静音在偏好的 `muted`。
- **音量分三档**：按人耳加权的响度，点击约 -28，干活和状态变化约 -24，奖励约 -20，都比说话轻。改了配方要重新量，把增益调回它那一档。
- **试听**：调试台（按 `` ` ``）的「音效」页逐个播放，并显示每个的响度。`test/shell_synth_test.dart` 拿 `test/fixtures/sfx.json` 逐样本比对合成的结果。
