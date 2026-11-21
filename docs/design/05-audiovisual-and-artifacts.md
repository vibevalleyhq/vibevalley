# 第五篇：视听多媒体、Artifact 与终端交互物理学

工作台的音频通话、素材库查看、弹性分栏、Artifact 演示与原生 Diff/文件/终端之间，统一遵守「原生重资产 + 工作台轻量协调」边界：重解码、实时 PCM、语法高亮和终端网格光栅全部放在 Rust 进程侧执行，工作台仅持有结构化视图和调度指令。

## 5.1 原生音频管线与程序化音效合成

### 独占租约与单队列音频驱动（`apps/mac/src/audio.rs`）

原生音频驱动（基于 macOS AVFoundation C 桥接 `vv_audio_*` / `vv_pcm_*` / `vv_capture_*`）由一条容量为 `64` 的 `audio-commands` 后台线程串行处理，并通过原子布尔锁 `CALL_RESERVED` 与 `CallAudio` RAII 租约实现独占互斥：

- **互斥保护**：本地媒体播放、语音朗读与实时语音通话不可同时抢占音频硬件；当 `reserve_for_call()` 被 `SpeechAudio` 或 `LiveVoice` 持有时，常规播放分发请求直接返回拒止错误；`CallAudio` 析构时自动执行 `capture_stop()` 与 `stop()` 并释放锁。
- **PCM 参数校验（`PcmFormat`）**：限制采样率 `8,000–192,000 Hz`、声道数 `1–2`（单声道或立体声 16-bit 小端整数）。Base64 分片上限 `2 MB`（`2 << 20` 字节），麦克风单次采集缓冲区固定 `640 * 10` 字节。
- **语音朗读状态机（`apps/mac/src/speech_audio.rs`）**：围绕四态枚举 `Phase` 运转：`Idle` → `Playing` → `Draining` → `Stopping`，并通过 `Claim` 句柄绑定服务端 `SharedSpeechStreams` 的生命周期回收通知。
- **实时双工通话（`apps/mac/src/live_voice.rs`）**：独立 `moss-live` 线程建立 WebSocket 语音流，维护四态 `Phase`（`Idle` / `Connecting` / `Live` / `Stopping`）、静音开关 `muted` 以及实时识别双轨字幕 `heard` / `said`。

### 程序化 8-bit 音效合成器（`apps/mac/src/audio.rs` 与 `apps/mac/ui/vv/web/ui/pixel/sound.ts`）

像素农场的界面动作与帮工提示音由原生合成器实时计算 PCM 波形并缓存标准 WAV 字节序列：

- `apps/mac/src/audio.rs` 中的 `synth` 模块提供 `Pen` 音轨画笔（音调、白噪声与滤波原语）与 `compose()` 作曲配方，按 `32 kHz` 采样率渲染并缓存全部音效，通过 `play_sound()` 直接播放，无需磁盘 I/O。
- `sound.ts` 定义全量音效表 `SOUNDS`（涵盖农具使用、收获金币、来电铃声、到达跳跃 `arrive` 等）与分组 `SOUND_GROUPS`，经 `hostApi.playSound` 统一交由原生音频驱动执行。

## 5.2 多模态媒体查看与素材库

素材库与多模态查看分布于 `apps/mac/ui/vv/web/features/media/` 与 `apps/mac/ui/vv/web/ui/Lightbox.tsx`：

- **灯箱（`Lightbox.tsx`）**：点击图片或媒体附件后全屏浮动于页面上方（`bg-scrim z-30`），一次展示一张，支持键盘左右方向键（`left`/`right`）翻页、ESC 关闭以及「用系统应用打开原文件」。
- **附件去重与展示（`AttachmentTile.tsx`）**：上传媒体经服务端按 SHA-256 哈希去重归档，工作台统一以统一磁贴渲染图标/缩略图、文件名与体积。
- **素材库三栏布局与筛选状态机（`LibraryPage.tsx`、`Rail.tsx`、`Tiles.tsx`、`Inspector.tsx`、`libraryView.ts`）**：
  - 左侧 `Rail` 按 `LibraryScope` 过滤媒体类别（全部、图片、音频、语音、理解任务、Artifact 等）。
  - 中部 `Tiles` 网格展示媒体卡片与生成任务进度，由 `libraryView.ts` 显式管理文件多选/范围选择、Artifact 选中、`Lightbox` 当前索引与删除确认态（`PickMode` 与 `reconcileSelection` 在列表刷新后自动清理失效选中项）。
  - 右侧 `Inspector` 按选定条目分派专用子面板（`ImagePanel.tsx` / `AudioPanel.tsx` / `SpeechPanel.tsx` / `UnderstandingPanel.tsx` / `JobFacts.tsx`）。

## 5.3 双轨弹性分栏物理学

应用内存在两层相互独立的分栏调节系统：

1. **工作台页面内分栏（`apps/mac/ui/vv/web/ui/Splitter.tsx` 与 `state/prefs.ts`）**：
   - `Splitter` 在面板边缘放置 `1px` 视觉分割线配隐形扩宽拖拽热区，`side` 参数指明分栏线位于被调节面板的哪一侧，从而保证「向外拖动总是加宽面板、向内拖动总是收窄面板」。
   - `usePaneWidth(pane, fallback, limits)` 实时写入 `state/prefs.ts`，通过 `state/stored.ts` 在 `localStorage` 中以 `vibevalley.prefs` 键落盘；读取使用 `orFallback(schema, default)` 做字段级 Zod 容错，避免单个损坏字段清零整份用户偏好。
2. **原生 GPUI 壳侧边栏与多窗格树（`apps/mac/src/shell.rs` & `panes.rs`）**：
   - 原生工作区 `/workspace` 的左侧项目栏与右侧检查器默认宽度均为 `280.0`，拖拽允许范围为 `SIDEBAR_MIN = 180.0` 到 `SIDEBAR_MAX = 560.0`。右侧检查器在窗口宽度低于 `1040.0px` 时自动隐藏（不破坏已有偏好设置）。
   - 主工作区内部通过 `vibevalley_workspace::Layout` 树支持水平/垂直任意递归切分；`SplitBounds` 缓存上一帧每个拆分节点在屏幕上的几何矩形，拖拽分割线时直接计算被共享相邻子窗格之间的精确分配比例（截断在 `[0.0, 1.0]`）。

## 5.4 Artifact 三态运行时与沙箱预览

Artifact 页面实现于 `apps/mac/ui/vv/web/features/artifact/`（`ArtifactsPage.tsx`、`PresenterPage.tsx`、`store.ts`、`HtmlFrame.tsx`）：

- **三种产物形态**：
  1. **结构化文档块（`blocks`）**：按块序列渲染的交互式富文档与图文组件。
  2. **持久状态（`store`）**：附带状态读取与本地表单交互的持久化 Artifact。
  3. **沙箱 HTML（`HTML`）**：由独立渲染容器（`HtmlFrame.tsx` / WKWebView 沙箱）托管运行，隔离脚本与样式污染。
- **演讲者模式（`/present`，`PresenterPage.tsx`）**：
  - 全屏独立于常规导航外框，提供当前幻灯片主视图、下一张预览窗口、演讲者备忘录与深/浅双主题切换支持。
  - 在原生环境中多视图内容就绪依赖各自 WebView 首次绘制回执，确保讲稿同步与切换无空白帧。
- **入口衔接**：`/artifacts` 路由与 `/library` 同归属于工作区导航的 `library` 空间，并在侧栏协同呈现频道上下文面板（`ChannelSidePane`）。

## 5.5 原生 Diff、文件查看与可点击终端

### 原生 Diff 审阅器（`apps/mac/src/diff.rs`）

- 支持 `Mode::Unified`（单栏上下对照）与 `Mode::Split`（双栏左右配对，按删除行与紧邻新增行逐行配对成 `Row::Pair`）两种排布。
- 依托 `vibevalley_git::DiffLine::emphasis` 高亮行内精确字符改动片段；单文件头行 `Row::File` 支持按文件折叠与二进制文件提示。
- 直接在原生端支持逐个 hunk 块执行 `stage` / `unstage` / `discard` 操作，变更完成后发出 `DiffChanged` 刷新侧栏 Git 状态。

### 只读文件查看器（`apps/mac/src/viewer.rs`）

- 设定 `MAX_BYTES = 8 * 1024 * 1024`（8MB）硬阈值，超过阈值或二进制文件直接呈现体量提示而不拖垮 UI 线程。
- 语法高亮与分行切分（`prepare()`）放于后台线程执行，通过 `clip_spans` 对字符边界做安全裁剪防止多字节 UTF-8 越界崩溃；支持跳转行定位（`scroll_to_line`）、图片预览、Markdown 触发宿主渲染预览及系统 `$EDITOR` 打开。

### GPU 终端与可点击链接引擎（`apps/mac/src/terminal/` & `crates/vibevalley-terminal/src/links.rs`）

- **逐列锁定排版（`terminal/element.rs`）**：窄字符按批量合并并强制每字步进 1 列宽；宽字符（CJK 与 Emoji）独立塑形并严格定位到 `col * cell_width`，彻底杜绝回退字体把同一行后续竖线和光标挤歪。
- **行缓存与平滑滚动**：`RowCache` 以行 `Arc<Row>` 身份做增量缓存，单帧仅重塑真正变化的行；滚轮追踪像素余数 `scroll_remainder`，按 `line_height` 精确折算整行滚动步长；内边距固定 `PADDING = 6.0`。
- **智能链接识别（`links.rs`）**：
  - 跨越最多 `MAX_WRAP_ROWS = 32` 行硬折行或软折行拼接还原被终端强行断行的长 URL 与带空格引号路径（`MAX_QUOTED_PATH_BYTES = 512`）。
  - 识别结果归为 `LinkTarget::Url`（过滤危险协议）与 `LinkTarget::File { path, line, col }`，结合终端当前 `cwd`、`project_root` 与 `HOME`（`LinkResolveContext`）解析相对路径、`~` 路径及行列定位，悬停高亮下划线且点击直达内嵌文件查看器或浏览器。

### 工作台内嵌代码与图表（`CodeBlock.tsx` 与 `Diagram.tsx`）

- **代码块（`apps/mac/ui/vv/web/ui/code/CodeBlock.tsx`）**：内嵌行内语法着色，默认超出 16 行时折叠并给出展开全文与一键复制按钮。
- **图表（`apps/mac/ui/vv/web/ui/code/Diagram.tsx`）**：识别 Markdown 中的 Mermaid 图表栅栏块并调度渲染成可阅读矢量图。
