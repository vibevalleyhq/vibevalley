# Agent Note: 游戏层往哪走：全用 TS，在 Pixi 上自己写引擎；Rust 等真要原生宿主时再进来

Status: rejected — 客户端换成了 Flutter，像素村用 Flame 画，没有走 TS 加 Pixi 自己写引擎；对 Rust、Bevy 和 Agora 绑定的评估仍然有用

## Problem

VibeValley 要做大：像素村和院子、更多地点和角色、帮工按日程在院子里走动、商店和装饰、昼夜和天气、桌面版、手机。画面这一层会长成一个真正的游戏引擎，引擎的大部分要我们自己写。主人在问底下垫什么：纯 TS，TS 的游戏框架，还是 Rust（Bevy）？Agora 没有能用的 Rust SDK，要不要自己写？这是长期押注，选错了换起来很贵，所以要好好评估。

不管选哪条路，有几件事是定的：

1. **核心状态只有一份，在 TS 里。** protocol 的 `reduce` 由服务端、页面、模拟服务器、桌面版主进程四处共用（[理由](../../implemented/architecture/2026-10-11-farm-core-state.md)）。
2. **界面大半是字。** 田头有 Markdown、@ 补全、中文输入法；还有干活过程、收成清单的 diff、计划板、配置页、成就面板。画面只占其中一块。
3. **语音是 Agora 网页 SDK 加 ConvoAI**，在页面（Chromium）里跑。
4. **服务端是 Node。** 管家用 pi，帮工用 oar，数据库是 PGlite（WASM）；桌面版用 Electron 把它带在身边（[理由](../../implemented/architecture/2026-10-11-desktop-client.md)）。（写这篇时的情形；后来服务端换成了 Go、客户端换成了 Flutter，见 [服务端用 Go 重写](../../implemented/architecture/2026-10-13-go-server-on-smith.md)、[客户端迁到 Flutter](../../implemented/architecture/2026-10-13-flutter-client-over-ts-server.md)。）
5. **代码主要由编码 agent 来写**，VibeValley 自己就是这么写出来的。

要自己写的那部分：院子、帮工去哪、动画、光影、点击、镜头、碰撞、粒子。这些不管选哪条路都得写。差别在三处：底下垫的是什么，和核心状态怎么接，谁来写、写得多快。

## 现在的样子（实测，2026-10-11）

- 游戏层的代码：`packages/engine` 约 1600 行（状态原语、React 画面部件、合成音效、寻路、Pixi 像素舞台），像素试验页 `web/src/pixel` 约 1200 行。
- 像素页在模拟农场里放 6 个帮工走动：M2 Max 上一直 60 帧；把 CPU 降到 1/6（Chrome 的 CPU 限速）还是 60 帧；JS 堆 23–29 MB。按现在的规模，画面离瓶颈还很远。
- 渲染层和核心状态之间的边界已经很窄：每帧拿一份快照进来，往外只送点击（[像素村](../../implemented/feature/2026-10-11-pixel-village.md)）。
- 下面第四条的第 1 级（效果）已经做在像素页上：从画生成的法线贴图、天光和调色、点光源、云影、雾、光晕、柔和的影子，都在 `engine/pixi` 里。夜里灯全开、CPU 降到 1/6 时约 59 帧。

## 外面的事实

- **Agora 没有官方的 Rust SDK。**
  - 社区的 `agorartc-sys` 3.1.4（[AgoraIO-Community/Agora-Rust-SDK](https://github.com/AgoraIO-Community/Agora-Rust-SDK)）包的是 2020 年的原生 SDK v3.1，2021 年以后没再更新；`agora-rtm` 只包了消息，不管音视频。
  - 官方的客户端 SDK：Web、iOS、Android、Windows/macOS（C++），以及 Electron、Flutter、React Native、Unity、Unreal、C# 的封装。服务端 SDK：Linux C++、Java、Go、Python。
  - 官方的各种封装（C#、Electron、RN）都不直接对着 C++ 头文件，而是走 **Iris**：一层很窄的 C 接口。`CreateIrisApiEngine` 建引擎，`CallIrisApi` 按方法名加 JSON 参数调用，`CreateIrisEventHandler` 收回调。要写 Rust 绑定，就绑这几个函数。
- **Bevy** 现在是 0.20（2026-10-08），0.19 是 2026-06，大约四个月出一个不兼容的版本。可编辑文字（`EditableText`）0.19 才有，输入法的支持还很初步。2D 的精灵材质、UI 部件这一年进步很快。
- **3D 和 2D 混着画**有两种做法，都已经有成功的游戏：
  - 《潜水员戴夫》（Unity URP）：人物和鱼是 16–32 像素的精灵，放在低多边形的 3D 海里，配高清的光照和背景。
  - 《死亡细胞》（[3D 做 2D 动画的流水线](https://www.gamedeveloper.com/production/art-design-deep-dive-using-a-3d-pipeline-for-2d-animation-in-i-dead-cells-i-)）：角色先在 3D 里建模、做动画，再按很小的尺寸、不抗锯齿渲成像素帧，每帧带一张法线贴图，游戏里用卡通着色照亮。
  - Pixi v8 能和 Three.js 共用一个 WebGL 上下文（[官方指南](https://pixijs.com/8.x/guides/third-party/mixing-three-and-pixi)）：同一块画布上一层画 3D、一层画 2D。
- **TS 的游戏框架**：
  - [Excalibur](https://github.com/excaliburjs/Excalibur)：TS 写的完整 2D 引擎，带 ECS、碰撞、瓦片地图、镜头，v0.32（2025-12）。
  - [KAPLAY](https://github.com/kaplayjs/kaplay)：TS，还在 alpha。
  - [Phaser](https://github.com/phaserjs/phaser)：源码是 JS，带 TS 类型，v4.2（2026-07）。
  - [Babylon.js](https://github.com/BabylonJS/Babylon.js)：TS，3D。
  - 渲染库 [PixiJS](https://github.com/pixijs/pixijs)：TS，v8.22（2026-10），WebGL 和 WebGPU 都支持。

## 评估

| | A. TS + Pixi，自己写引擎 | B. TS 的完整引擎（Excalibur / Phaser） | C. Bevy 编成 WASM，只当渲染层 | D. Bevy 原生当宿主，Rust 接 Agora | E. Godot / Unity |
|---|---|---|---|---|---|
| 核心状态只有一份 | 渲染层只读快照，天然合 | 框架自带场景和角色状态，要天天同步，容易长出第二份 | 快照要过 JS↔WASM 的桥，状态还在 TS 里 | 宿主换成 Rust，状态要么在 Rust 里再写一份，要么隔着进程传 | 同 D，还多一门语言 |
| 文字界面（中文、输入法、Markdown、diff） | DOM 照旧 | DOM 照旧 | DOM 照旧，叠在 canvas 上 | 要么用 Bevy 重写（输入法刚起步），要么再嵌一个 WebView | 弱项 |
| 语音 | 网页 SDK 照旧 | 照旧 | 照旧 | 要自己写 Iris 的 Rust 绑定，还要分平台打包 | 有官方 Unity 插件，Godot 没有 |
| 画面上限（像素、光影、规模） | WebGL / WebGPU；按现在的规模绰绰有余，光影要自己写着色器 | 差不多，多了现成的碰撞和地图 | 最高 | 最高 | 最高 |
| 写得快不快（agent 熟不熟、多久变一次） | 最熟；Pixi 大版本几年一次 | 熟；但是在框架的规矩里写 | Rust + Bevy，四个月破坏一次，模型记的多半是旧版本 | 同 C，再加 FFI 和多线程回调 | 要在编辑器里干活，agent 难插手 |
| 构建和分发 | 现有的 Vite | 现有的 | 多一套 cargo / wasm-bindgen，加几 MB 的 WASM | 每个平台一套原生构建，网页版没了 | 同 D |
| 改主意的代价 | 边界窄，以后换渲染层不用动 TS | 和框架绑得深 | 中等 | 很大 | 很大 |
| 量级（粗估） | 接着做，已经开了头 | 2–4 周把场景搬过去，之后一直维护同步代码 | 1–2 个月搭起来，之后每四个月跟一次升级 | 3–6 个月，网页版也没了 | 同 D |

结论：

- **Rust 和 Bevy 能换来的（极限性能、3D、大世界）**，眼下的 VibeValley 都用不上，实测离瓶颈很远。**要付出的**却正好落在我们最重的几处：一份核心状态、满屏的中文字、网页里的语音，还有靠 agent 写代码的速度。
- **完整的 TS 框架**省下的是碰撞、地图、镜头这几块，但它要当主人，自带场景和角色状态，和「核心状态只有一份」冲突。像素村当初也是因为这个没选它。
- **自己写引擎**是对的，但只写在渲染库之上，不要从零写渲染。

## Proposal

**一、全用 TS。渲染用 Pixi，引擎写在 `@heybro/engine` 里。**

现在的 `engine/pixi` 和 `web/src/pixel` 里，和农场无关的部分要长成几个有测试的模块：

| 模块 | 管什么 |
|---|---|
| 世界和图层 | 瓦片地图、按 y 排序、前后景、像素对齐 |
| 走路 | 可走的格子、碰撞、地点（接着用 `engine/nav`） |
| 镜头 | 跟随、整数倍缩放、抖动 |
| 角色 | 姿势 → 帧、朝向、动作排队（解决「一秒多次工具调用就闪」，见[提案](../../proposed/feature/2026-10-09-action-queue.md)） |
| 光影和昼夜 | 光源、阴影、按时间换调色板 |
| 效果 | 粒子、飘字 |
| 点击 | 命中区域、指针 |
| 音效 | 接着用合成的那一套 |

规矩是：叶子借现成的库（Pixi 的瓦片地图、滤镜），不借框架；Pixi 只出现在 `engine/pixi` 里，大版本升级只改这一处。

**二、把渲染边界写成接口。** 渲染层只做两件事：读核心状态加每帧的瞬时状态（位置、帧、光），往外送意图（点了谁、点了哪块地）。它不持有任何事实。

这个接口（比如叫 `SceneDriver`）放进 engine，像素页和以后的画面都照它来。这样哪天真要换成 Bevy 编的 WASM，换的也只是这一层。

**三、Rust 先不进来，写清楚什么时候进来。**

满足下面任意一条，就另写一篇 Note 重新评估：

1. 有功能必须要原生宿主，网页和 Electron 都做不到。比如上架手机应用商店的原生 App、只能在系统层做的音频路由。
2. 在目标机器上量出了画面的天花板，降低画质也解决不了。
3. 3D 的世界大到 Three.js 或 Babylon.js 在目标机器上撑不住，或者要流式加载。只是「要有 3D」不算：上面第四条在 TS 里就能做。

真要原生语音时：桌面版先试官方的 Electron SDK（不用写绑定）。真要 Rust 时，绑 Iris 的 C 接口，不要对着 C++ 头文件做绑定。只做音频（进出频道、静音、设备、回调）的绑定，估计 1–2 周能跑起来；之后要分平台打包、跟 Agora 的升级。

**四、效果和 3D 也在 TS 里做，一级一级加。** 每一级都只换渲染边界后面的东西，core 不动：

1. **效果**：光影、水、雾、粒子、景深、辉光，用 Pixi 的滤镜和自己写的着色器。精灵带一张法线贴图，就能被会动的光源照出立体感。这一步不用 3D。
2. **3D 的模型，2D 的样子**（死亡细胞的做法）：在 Blender 里建模、做动画，离线渲成像素帧和法线贴图，游戏里照样当精灵画。运行时还是 2D，素材流水线多一步。
3. **2D 的角色放进 3D 的场景**（潜水员戴夫的做法）：加一层 Three.js 画院子、水面、地形，和 Pixi 共用一个 WebGL 上下文，人物和字还是 Pixi 和 DOM。场景再大，就把整个渲染层换成 Three.js，精灵当公告板。Babylon.js 也行（TS 写的、带调试器），Three.js 的例子和 agent 的熟悉程度更好。
4. **3D 实时渲成像素**：低分辨率渲染再按最近邻放大，压调色板、描边，用 Three.js 的渲染目标和后处理。

真正难的是 3D 的素材：codex 画的是图，不出模型。要做到第 2 级以上，得有一条做模型的路：Blender 手做、图生 3D 的工具、或买现成的。这比选引擎更早要定。

**五、雄心放在别人做不了的地方。**

VibeValley 别人难抄的是三样：

- 指挥一队编码 agent：派活、种植计划、记性、账本。
- 让它们的活看得懂：地里长什么、帮工去哪、田头。
- 说话就能指挥。

引擎只要不拖后腿。新东西的预算花在这三样上，不花在换渲染技术上。

**分步：**

1. 像素页已经换掉手绘页（[像素村](../../implemented/feature/2026-10-11-pixel-village.md)），手绘页留作旧版。引擎模块照上面拆。
2. 把渲染边界接口和第一批模块（世界和图层、镜头、角色）从 `web/src/pixel` 挪进 `engine/pixi`。「帮工去哪」的规则挪进 core，写成纯函数，补测试。
3. 加一个画面预算的检查脚本：一个院子、50 个角色、200 个摆件，CPU 降到 1/4 时保持 60 帧，改引擎时跑一次。
4. 再往院子里加内容：地点、日程、商店的装饰。

## Alternatives considered

上面「评估」一节逐个比过 B–E。这里补两条没进表的：

**一半 TS、一半 Rust：先用 Bevy 写引擎模块，编成 WASM 给 Pixi 用。** 性能留出了余地，但每个模块都要过一道 JS↔WASM 的桥，状态和对象在两边各一份，调试要跨两种语言。量出的帧时间说明眼下不需要，复杂度却是现成的。

**现在就把 Agora 的 Rust 绑定写好备着。** 写起来不难（Iris 只有几个 C 函数），但没有宿主用它，就只是一份要跟着 Agora 升级的代码。等真要原生宿主那天再写，那时候也知道该绑哪些功能。

## Acceptance criteria

- 游戏层只有 TS；Pixi 只在 `engine/pixi` 里出现。
- 渲染边界是 engine 里的一个接口，有测试；像素页的整个画面都由快照驱动，点击只往外送意图。
- 世界和图层、镜头、角色三个模块在 engine 里，各有测试；「帮工去哪」是 core 的纯函数，有测试。
- 画面预算的检查脚本能跑，结果写进 [framework.md](../../../../docs/framework.md)。
- 仓库里没有 Rust。哪天要加，先有一篇 Note 说明满足了上面三条里的哪一条。

## Risks

- **自己写引擎会越写越多。** 用上面那张模块表圈住范围，叶子借库；表外的东西要先说为什么。
- **Pixi 的大版本**（v7 → v8 是不兼容的）：只在 `engine/pixi` 里出现，升级时只改一处。
- **光影要自己写着色器**，像素风的光照可能要调很久。可以先用调色板和叠加层做出八成的样子。
- **3D 的素材没有现成的流水线**：codex 只出图。要做 3D 效果，先定模型从哪来，再动渲染层。
- **Pixi 和 Three.js 共用一个上下文**，两边会互相留下 GPU 状态，每次画之前要 `resetState()`；两层的大小、像素比要一致。
- **真要原生宿主的那天，代价还在**：要写 Iris 绑定，文字界面仍然要嵌 WebView。这条路没有被堵死，只是推迟了，到时候的成本在这里记着。
- **想招 Rust 游戏开发者的话**，Bevy 更有吸引力。但这个项目主要靠 agent 写代码，选 agent 最熟的语言更要紧。
