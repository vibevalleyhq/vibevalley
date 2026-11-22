# Agent Note: Pure-Rust native collaborative whiteboard (`VvWhiteboard`)

Status: proposed

## Problem

当前工作台的协作白板（[WhiteboardView.tsx](apps/mac/ui/features/artifact/WhiteboardView.tsx) 与原 `apps/mac/ui/features/artifact/whiteboard.ts`）在内嵌 `<WebView>` 中维护一套独立的 HTML/SVG/JS 运行时，带来三个结构性问题：

1. **重复造轮子与无静态类型检查**：[crates/rich/src/engine/canvas/](crates/rich/src/engine/canvas/mod.rs) 已提供纯 Rust 的几何路由、命中测试、对齐吸附、Undo/Redo 与渲染能力；WebView 内嵌 JS 字符串既无法复用 Rust 内核，也失去编译器和静态检查保护。
2. **原生层 `NSView` 遮挡与风格割裂**：macOS 上 `WKWebView` 作为原生子窗口浮于 GPUI 之上，导致底部工具栏（`#wb-dock`）、贴纸弹层与内联编辑被迫用手写 CSS 在网页内实现，无法直接复用原生组件与设计令牌，也无法原生弹出中文 IME 输入框与上下文菜单。
3. **测试与可视化盲区**：`vp run ui:gallery` 依赖 GPUI `--features shot` 离屏抓取主窗口像素，无法采集 `WKWebView` 子视图内容，使白板画布在原生回归图册中退化为纯色空白，同时交互状态机无法纳入 `cargo test -p vibevalley-rich`。

## Proposal

采用「复杂交互组件下沉 `crates/rich`、TSX 只保留数据绑定与页面薄壳」的分层架构，在 `vibevalley/rich` UI 集合中构建零 `WKWebView` 的纯 Rust 原生协作无限白板组件 `VvWhiteboard`：

1. **十四模块纯 Rust 白板引擎（`crates/rich/src/engine/whiteboard/`）**：
   - `model.rs` / `codec.rs`：进门一次解码 `artifact.entry.*`（`board/meta`、`elements/*`、`presence/*`）为封闭 13 变体 `ElementKind` 与 `BoardDoc`（保留 `ExtraFields` 前向兼容，门内零 `serde_json::Value` 业务分支），支持增量 `patch` 与 `if_rev`，并支持导入标准 JSON Canvas 1.0。
   - `spatial.rs` / `geometry.rs` / `layout.rs`：256u 网格空间索引与视口裁剪；Catmull-Rom 样条、折线弧长采样与里程碑投影、平滑/正交避障/直线连线路由、旋转 OBB 计算；CJK 与拉丁混排精确测宽与高亮胶囊定位。
   - `stickers.rs` / `templates.rs`：24+ 枚统一手绘粗描边纯矢量贴纸（零 `<text>`，由 `nsh_core::svg::drawing` 解析并 LRU 缓存）与 5 套即用模板（产品发布时间线、系统架构图、用户旅程图、四象限、对比矩阵）。
   - `hit.rs` / `snap.rs` / `ink.rs`：8 向缩放柄、旋转柄、N/E/S/W 锚点端口、连线拐点与时间线里程碑命中，双向框选；边缘/中心对齐与等距间距磁性参考线及对齐/分布/规整排版；压感/速度变宽手绘墨迹轮廓、荧光笔、RDP 简化与橡皮擦相交擦除。
   - `ops.rs` / `interaction.rs`：200 步有界事务撤销栈（拖拽合并提交、远端 `rev` 更新隔离、子图复制连线 ID 重映射与容器父子随动）与无窗口依赖的确定性 `WhiteboardController` 状态机。
   - `paint.rs` / `export.rs`：基于 `nsh_core::canvas` 的双层动静分离渲染器（底层静态场景缓存 + 顶层拖拽/吸附/手绘/光标实时叠加层 + Minimap + `CanvasNode` 无障碍节点），以及 1:1 Light/Dark 自包含 SVG、2× 高清 PNG（`Painter::render`）与 JSON/JSON Canvas 导出。
2. **原生 `VvWhiteboard` 组件与薄壳绑定（`crates/rich/src/whiteboard.rs`）**：
   - 注册进 `"vibevalley/rich"`，挂载双层 `CanvasView` 与原生悬浮 Dock、选中上下文操作条、双击原地中文 IME `<Input>`、贴纸/色板/模板弹层、Minimap、协作者头像跟随与右键菜单。
   - [WhiteboardView.tsx](apps/mac/ui/features/artifact/WhiteboardView.tsx) 收窄为数据订阅与持久化薄壳（订阅 `artifact.entry.*` 与在线 `Session`，转发批量写回、文件导出与右侧栏对话聚焦），彻底移除原 `apps/mac/ui/features/artifact/whiteboard.ts` 与 `WKWebView` 白板运行时。

## Alternatives considered

- **继续保留 `WKWebView` 内嵌 HTML/JS**：短期改动最小，但继续与 `crates/rich` 维护两套几何与渲染实现，原生叠层与 IME 体验受限于 `NSView` 层级，且无法进入 GPUI `shot` 自动化画廊。
- **直接把全画布拼成一个大 SVG 喂给 `VvCanvas`**：每帧拖拽都要重新拼接并解析整幅 XML 字符串，数百个节点时交互帧率与内存抖动不可控，也不支持动态层局部增量与压感墨迹流。双 `CanvasView` 动静分离配合 `nsh_core::Painter` 与静态缓存可将拖拽重绘代价隔离在少数活动图元上。
- **为协同白板改造原有 `engine/canvas`（JSON Canvas 1.0）**：`engine/canvas` 服务于 Markdown 与 GenUI 内嵌的静态 JSON Canvas 1.0 文档，模型边界极简；将其塞入时间线丝带、压感笔迹、贴纸与并发 `rev` 状态会破坏其契约清晰度，新建专职 `engine/whiteboard` 并保留 `import_json_canvas` 互通更干净。

## Acceptance criteria

1. `crates/rich/src/engine/whiteboard/` 全 14 模块与 `VvWhiteboard` 在 `#![forbid(unsafe_code)]` 下编译通过，`cargo clippy -p vibevalley-rich --all-targets -- -D warnings` 零警告。
2. `crates/rich/tests/whiteboard_engine.rs` 与 `whiteboard_render.rs` 覆盖 13 种元素编解码往返、3 种连线路由、空间索引裁剪、磁性吸附、手绘与擦除、200 步 Undo/Redo 与并发远端更新合并、Light/Dark SVG 与高清光栅渲染验证。
3. [WhiteboardView.tsx](apps/mac/ui/features/artifact/WhiteboardView.tsx) 经 [rich.ts](apps/mac/ui/infra/rich.ts) 接入 `<VvWhiteboard />` 并移除内嵌 WebView 白板运行时；`vp run ui:gallery` 在 `vibevalley-mac --features shot` 中直接截出完整浅/深色白板实机截图，且通过全套 `release:verify`、`comment-review.ts`、`deadcode` 与 CI 检查。

## Risks

- **文本测量精度差异**：离线 SVG 导出与 `nsh_core::canvas` 间的中英混排断行与高亮背景需要共用 `layout.rs` 测量规则；Phase 3 通过离线光栅出图与对比校验提前消除偏差。
- **`nsh test` 环境无 `vibevalley/rich`**：headless `nsh test` 仅加载 `nsh/base`（见 [rich.ts](apps/mac/ui/infra/rich.ts)），因此渲染与交互状态机深入 `cargo test -p vibevalley-rich`，TSX 侧保留同步与降级壳测试，实机像素由 `vp run ui:gallery` 兜底。
- **`#![forbid(unsafe_code)]` 与依赖边界**：`crates/rich` 严禁 `unsafe`，所有 SVG 矢量贴纸与自定义 SVG 解析经 `nsh_core::svg::drawing` 的字节数/文本量/嵌套深度限制及服务端清洗守门。
