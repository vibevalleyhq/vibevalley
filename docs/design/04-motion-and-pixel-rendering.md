# 第四篇：动效物理学、3D 纸雕渲染与光影系统

VibeValley 在工作台微交互上保持克制，而在原生 Papertrails 纸雕农场中实现了一套跨平台纯 Rust `wgpu` + WGSL 立体纸雕渲染、昼夜光影与偶人物理引擎。

## 4.1 工作台微交互与合成属性约束

- **合成优先级**：工作台过渡属性限制在 `colors`、`opacity`、`transform` 与明确宽/高小部件（如开关滑块），杜绝大面积表格或滚动列表使用宽泛的 `transition-all`。
- **宿主交互反馈与减弱动态**：工作区外壳（`apps/mac/ui/workspace/`）与工作台统一使用 `nsh.json` 中的 `transition duration-120 ease-out` 令牌类，由底层 `nsh` 运行时统一遵循系统减弱动态设置。
- **高频计时降频**：运行耗时读秒按 `100ms` 节拍或时间差刷新，兼顾跳动细腻与渲染开销。

## 4.2 Rust 3D Papertrails 纸雕渲染管线

原生应用的纸雕场景（`DioramaView`）与开场欢迎画（`OpeningView`）位于 `apps/mac/src/diorama/` 与 `apps/mac/crates/diorama/`：

### 纸雕网格、纸纹与离屏帧缓冲（`apps/mac/crates/diorama/` & `apps/mac/src/diorama/scene.rs`）

- **单源精简编译产物（`assets/diorama/`）**：由同级 `vibevalley-assets` 仓经 `design/diorama.sh` 编译并同步 `manifest.json`、`meshes.bin`（VVM2 网格）、`lights.json`、`foley.json` 与 `print/`、`stock/` 棉纸纤维/切边贴图。
- **离屏 `wgpu` 渲染与 GPUI 上传（`apps/mac/src/diorama/view.rs`）**：`DioramaScene` 在后台 `spawn_blocking` 线程执行 `wgpu` + WGSL 阴影贴图、主体着色与移轴景深合成。合成着色器输出 GPUI 使用的 BGRA 像素，`FrameSurface::paint_bgra_frame` 按帧号去重上传。镜头运动时上限为 1280 × 832 px，停稳 300 ms 后按窗口密度绘制，上限为 2048 × 1312 px。渲染在交互（`16ms`）、空闲（`66ms`）与切离失活（`0 FPS`）之间按需节流。关闭动效时，镜头、纸页合页和昼夜光照直接取目标状态。

## 4.3 昼夜光影与开场氛围

### 四档时光与灯光预设（`assets/diorama/lights.json`）

- **四档时光（`TimeOfDay`）**：`Dawn`、`Noon`、`Dusk`、`Night`（默认随本机挂钟 `wall_clock_time_of_day()` 选择，支持快捷键 `1..4` 或调试命令 `diorama_clock` 切换）。
- **屋顶掀顶切面与聚焦**：点击院内建筑或按 `Space` 可驱动屋顶铰链平滑掀开，呈现内景与对应业务入口，按 `Esc` 退出聚焦。

### 开场欢迎画（`apps/mac/src/diorama/opening.rs`）

- **Papertrails 时段开场（`OpeningView`）**：按本机小时分档解码 `assets/brand/opening-{morning,day,night}.webp`（`05..09` 清晨、`10..17` 白日、其余夜晚），经 GPUI `img(Arc<RenderImage>).object_fit(ObjectFit::Cover)` 全幅渲染并配合弱引用缓存在退出开场后立即回收显存，底部叠放暖纸进度条与启动阶段说明。

## 4.4 帮工偶人运动与农庄手机

帮工偶人的切片映射与场景交互实现于 `apps/mac/src/diorama/frame.rs`、`scene.rs`、`phone.rs` 与 `apps/mac/ui/farm/`：

- **河道、拱桥寻路与弹簧偶人**：`DioramaWorld` 根据服务端切片中帮工的当前动作（`place_of_action`：`read_file`/`search` 去书屋、`run_command`/`mcp` 去工坊、`web` 去信号塔、`wait` 去长椅，其余留在地块旁）驱动偶人沿院内石径与拱桥移动，带弹簧骨骼摇摆与到站停驻。
- **农庄手机与内嵌小游戏**：左下「手机」组件（`apps/mac/src/diorama/phone.rs`、`apps/mac/ui/farm/FarmPhone.tsx`）管理实时来电（默认保持 `20s` 响铃窗口与最多 `40` 条通话回溯日志），并在宽屏下可展开聊天频道及 5 款内嵌掌机小游戏（`blocks` / `sokoban` / `dino` / `bugs` / `merge` + 方向键与 AB 键）。
