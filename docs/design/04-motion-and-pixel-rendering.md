# 第四篇：动效物理学、像素三渲二与光影系统

VibeValley 在工作台微交互上保持克制，而在原生像素农场中实现了一套不依赖 GPU 着色器管线的纯 Rust CPU 2.5D 像素渲染、3D 体素烘焙投影与昼夜氛围物理引擎。

## 4.1 工作台微交互与合成属性约束

- **合成优先级**：工作台过渡属性限制在 `colors`、`opacity`、`transform` 与明确宽/高小部件（如开关滑块），杜绝大面积表格或滚动列表使用宽泛的 `transition-all`。
- **宿主折叠动画**：原生宿主集成面的多步骤折叠/展开（`apps/mac/ui/components/ToolCallCard.tsx` 等）调用 `apps/mac/ui/motion.ts` 中的 `animateLayout()`（内部封装 `nsh` 的 `LayoutAnimation.configureNext`），统一受 `reduceMotion()` 约束——当系统启用减弱动态效果时 `ms(d)` 直接返回 `0`，保证终态照常呈现而无动画延迟。
- **高频计时降频**：运行耗时读秒（`formatElapsed`）按 `timerTick = 100ms` 步进刷新（1 分钟以内显示小数后一位 `0.1s`），兼顾跳动细腻与渲染开销。

## 4.2 Rust 像素三渲二渲染引擎

原生应用的 5 个像素场景（`Farm`、`Map`、`Tree`、`Opening`、`Catalog`）共享同一管线：逻辑构建帧列表 [`DrawList`](apps/mac/src/pixel/draw.rs) → CPU 光照合成/光栅 → [`SpriteCache`](apps/mac/src/pixel/element.rs) 最近邻缓存 → GPUI 1:1 绘出。

### 体素 3D `.glb` 实时光栅（`apps/mac/src/pixel/glb.rs`）

针对需要随姿态、工具与多帧动画变化的立体精灵，引擎在启动与按需时直接加载 `assets/models/` 下的 `.glb`（glTF 2.0 二进制模型）做 CPU 正交光栅化：

| 机制 | 实现参数与行为 |
| --- | --- |
| **相机与尺度** | 正交视图（`OrthoProj`），基准视口跨度 `ortho_scale = 2.95`（特定视角如俯视/微件可调整，例如 `1.32`），按模型包围盒缩放使脚底紧贴逻辑足点 (`ay`) |
| **三点暖光照** | 主阳光 `key_light = (-0.46, 0.78, 0.42)` + 冷天光 `fill_light = (0.60, 0.34, -0.46)` + 环境底光 `0.35 + 0.65·key + 0.18·fill`；再以 **6 阶色带量化**（`(light * 6.0).round() / 6.0`）制造手绘阶梯明暗，并附加暖红偏移与自发光通道 `emissive` |
| **2× 超采样去噪** | 先按双倍分辨率光栅计算三角形深度缓冲与光照色彩，再每 `2×2` 子像素块投票（出现次数最多的不透明源材质色胜出，覆盖 ≥ 2 个才成像素），避免抗锯齿混出脏中间色 |
| **单向轮廓描边** | 当 `outline == true` 时，检测精灵右、下边缘相邻透明处，对轮廓内侧像素按 `0.73` 亮度压暗，维持受光面干净而背光侧边线清晰 |
| **骨骼与表情切换** | 支持多段命名动画帧插值（四元数 `slerp`）及通过缩放归零切换不同表情或手里农具节点 |

### 384×256 画布与双角度投影（`projection.rs` & `sky.rs`）

- **基础画幅**：主村庄逻辑基准画布固定为 `384×256` 逻辑像素（`LEVEL_WIDTH = 384.0`），图集密度 `density` 由 `map` 底图尺寸导出（标准为 `2.0`，即 2× PNG 像素对应 1 逻辑像素）。
- **相机配置（`assets/village-camera.json`）**：村庄俯视偏转角 `yawDegrees: 30.0`、俯仰角 `pitchDegrees: 38.0`、原始布局倾角 `layoutPitchDegrees: 52.0`、`zoom: 0.87`（群岛模式 `islandZoom: 0.92`、`islandLayoutPitchDegrees: 40.0`）。`ground()` 与 `unproject()` 负责将 LDtk `village.ldtk` 的地面平面坐标与屏幕点击坐标精确互转。
- **整框防裁切（`frame_cover` 与 `fit_framing`）**：
  - 农场场景调用 `frame_cover`，允许裁剪边幅上限为 `FARM_CUT = (0.05, 0.08)`（左右最多裁 5%、上下最多裁 8%），防止极端宽高比窗体切掉建筑，过窄窗体会退回保持地标完整。
  - 图鉴等视图调用 `fit_framing`，采用半步整数比例缩放（`>= 1.0` 时按 `0.5` 递增取整），并由 `SpriteCache` 提前用 CPU 最近邻放大到整设备像素 (`resample`)，规避 GPUI 默认线性纹理采样造成的模糊。

### 深度排序与 2.5D 遮挡掩码（`draw.rs`、`landmarks.rs`、`crates/vibevalley-pixel/src/surface.rs`）

1. **Feet Y 排序**：场景中所有地块、道具与移动小动物先按足底接地投影纵坐标（`feet.y`）升序排序入 `occludable` 分组，保证前后重叠秩序。
2. **建筑 2.5D 掩码遮挡**：图集启动时载入 `assets/pixel/yard-landmarks.png`（R 通道标记建筑交互 ID `skills` / `manager` / `runtimes`，G 通道存储该建筑像素在地平面对应的遮挡 Y 深度）。`surface.rs` 在绘制可遮挡元素时逐像素校验 `depth > feet`，当帮工走到屋后或门廊后面时，自动被屋檐或墙体前缘遮挡。

## 4.3 昼夜光影与开场氛围

### 太阳周期与 `DayClock`（`apps/mac/src/pixel/sky.rs`）

- **周期标定**：一昼夜默认 `day_seconds = 600.0` 秒，默认开场时刻 `tod = 0.42`（上午时分），`clock_text()` 以每 5 分钟对齐输出 `HH:MM`。
- **光照曲线**：
  - 日出平滑窗 `[0.22, 0.30]`，日落平滑窗 `[0.76, 0.84]`，`dusk_of` 在 `0.26` 与 `0.80` 处形成双黄昏/破晓峰值。
  - 环境底色在 `DAY_AMBIENT [0.62, 0.64, 0.68]`、`DUSK_AMBIENT [0.66, 0.5, 0.46]` 与 `NIGHT_AMBIENT [0.26, 0.32, 0.52]` 间平滑混合；并混合对应 `Grade`（曝光 `exposure`、饱和度 `saturation`、暗部抬升 `lift`、阴影/高光偏色与暗角 `vignette`）。
- **点光源与云雾（`crates/vibevalley-pixel/src/light.rs`）**：
  - `Window`（`0xffd399`, 仅夜间亮）、`Lamp`（`0xffc579`, 强夜间光）、`Forge`（`0xff974c`, 叠加双正弦 `7rad/s` 与 `13rad/s` 炭火闪烁脉动，全天带底光）以及夜间萤火虫；按光源影响能量降序排序进 `Lighting::lamps`。
  - 云影与晨雾采用跨着色器/CPU 严格一致的 `cloud_hash()` 确定性噪声算法，防止不同显卡与无头验收帧产生云团漂移差异。
- **前景与 HUD 抗压暗分离（`farm_picture`）**：
  - `list.ops` 按索引区间分段渲染：先绘受光地景与 `occludable` 角色 → 执行 `surface.shade(&light.lighting)` 进行夜间乘色与光源调色 → 绘自发光光晕 `Op::Glow`（叠加模式） → 最后用 `flat_light * 0.82` 轻量着色近景树枝/草丛边框（`foreground`），防止前景遮罩在夜晚变成纯黑剪影；UI HUD 在最末独立按 view 像素叠加，不受场景夜间调暗影响。

### 开场、记忆树与图鉴专有氛围

- **开场（`opening.rs`）**：按本机小时分档选图（`05..09` 清晨、`10..17` 白日、其余夜晚），基准尺寸 `418×235.25`（原图四分之一）；底部覆 `#15141344` 至 `#151413dd` 线性暗幕渐变，进度条上方伴随 `opening-sprite.webp` 五段情绪小人奔跑（对应未启/行进/高进度/完成/失败）。
- **记忆树（`tree.rs`）**：基于确定性随机树冠基因（`MAX_DEPTH = 6`, `UNFOLD = 0.14`）生长，轮次数越多枝叶越茂盛；按节点挂接绿色/金黄记忆叶子、果实与种子袋，点击 18px 半径内可弹卡阅读长期记忆内容；背景山丘按 `clock.tod` 平滑过渡 `tree-hill` 与 `tree-hill-night`。
- **图鉴（`catalog.rs`）**：14 个常设货架（`帮工`、`助手`、`宠物`、`地块`、`院子`、`地图`、`农机`、`图标`、`动作`、`奖章`、`Logo`、`语言`、`界面`、`其他`）配合三种预设底面（格子 `0xf4ecd8` / 草地 `0x7fa650` / 夜色 `0x1c2233`）检验全部离线切片。

## 4.4 帮工运动与行为防抖物理学

帮工自主漫步和动作调度实现于 `apps/mac/src/pixel/farm/world.rs`、`nav.rs`、`scene.rs` 与 `hud/chrome.rs`：

- **A\* 网格寻路与移动**：`NavMap` 对可步行区做边缘安全间隙裁剪并计算最短路径；`Walker` 以 `WALK_SPEED = 42.0` 逻辑像素/秒行进，步长周期 `STRIDE_LENGTH = 15.0`；新加入帮工自带 `HOP` 弹跳高度数组 `[2.0, 4.0, 5.0, 4.0, 2.0, 1.0]`（`0.3s`），离开院子先渐隐 `FADE_S = 0.8s`（总保留窗口 `GONE_S = 3.6s`）。
- **视差缓动**：农场近景枝叶层随指针偏移产生最高 `3px` 视差移动（平滑因子 `dt * 2.5`）。
- **双稳态移动防抖（`Whereabouts` 与 `PoseHold`）**：
  - AI 帮工高频切换工具时，`read_file`/`search` 去图书馆、`run_command`/`mcp` 去工坊、`web` 去信号塔、`wait` 去长椅，其余在地块旁操作。
  - 若每次微动作立刻出发，角色会在地里折返抽搐。因此 `Whereabouts` 要求双阈值同时满足才更换目标地：**新目的地意愿连续持续 `SETTLE = 1.2s`** 且 **已在当前位置停留满 `DWELL = 2.0s`**（除非陷入 `Asking` 提问或作物枯萎/干旱 `urgent` 态立刻打断）。
  - 动作姿势同样由 `PoseHold` 锁存至少 `POSE_MIN_S = 0.8s`；场景内按固定节拍 `WHERE_TICK = 0.3s` 与 `STROLL_TICK = 0.6s` 抽样评估微步游走。
- **6 把农具与农庄手机**：
  - 底部 `36px` 高像素工具栏（`chrome.rs`）排列 6 把工具（快捷键 `1..6`）：`Hand`（默认点开详情）、`Water`（浇水 = 回复继续）、`Bug`（除虫 = 纠错恢复）、`Weed`（除草）、`Harvest`（收获 = 交付完成）、`Shovel`（铲除 = 停止/关闭工单）。
  - 左下「手机」组件（`phone.rs`、`FarmPhone.tsx`）管理实时来电（默认保持 `20s` 响铃窗口与最多 `40` 条通话回溯日志），并在宽屏下可展开聊天频道及 5 款内嵌像素 LCD 小游戏（`blocks` / `sokoban` / `dino` / `bugs` / `merge` + 十字键与 AB 像素手柄）。
