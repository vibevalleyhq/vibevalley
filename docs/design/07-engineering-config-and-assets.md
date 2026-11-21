# 第七篇：工程架构、跨平台接口与像素资产管线

工作台代码与原生界面工程上围绕四个基座构建：`nsh` 运行时与响应式适配、桌面跨语言桥接、离线资产加工生产链以及多密级自动化视觉验收管线。

## 7.1 `nsh` 运行时适配与响应式桥接

工作台 TSX 源码运行在 `nsh` 原生视图运行时（而非浏览器 DOM）之上，共享基座原语导出清单由 [primitives.md](docs/reference/primitives.md) 索引，并由两层轻薄适配桥接业务逻辑与原生底层：

| 模块 | 文件 | 核心机制 |
| --- | --- | --- |
| **Solid 2 响应式兼容层** | `apps/mac/ui/infra/solid.ts` | 由于 `nsh` 打包器拒绝直接打入 `solid-js`，`solid.ts` 直接基于 `nsh` 原生 `signal` / `computed` / `effect` / `context` 实现工作台所依赖的 `createSignal`、`createMemo`、`createEffect`（支持 Solid 2 的拆段副作用与 `{ defer: true }` 跳过首次执行）、`onSettled`、`createContext` 与 `useContext`；针对全量 `StateFrame` 更新，`equals: false` 选项通过外包 `{ v }` 盒对象绕过 `nsh` 默认的 `Object.is` 拦截，确保每次新帧推送必然触发下游依赖重算 |
| **宿主补丁与运行时垫片** | `apps/mac/ui/infra/polyfill.ts` | 为 `nsh` JavaScript 环境补充标准 Web 运行时能力缺口（如路径/正则/全局垫片），在页面与农庄手机入口顶部首个加载 |
| **条件热读取与打包嵌入** | `apps/mac/build.rs` | 自动寻址 `.tools/bin/nsh`（或 `NSH_BIN` / `PATH`），调用 `nsh build apps/mac/ui/App.tsx` 编译产生成品 JS 包与白名单文件 `capabilities.json`；在 **Debug** 构建中若 `ui/build/` 已存在产物则直接从磁盘热读取（修改 TSX 无需重新编译 Rust 壳），而在 **Release** 构建或设置 `VIBEVALLEY_EMBED_UI` 时强制全量编译并静态嵌入 Rust 二进制 |

## 7.2 桌面桥接协议与宿主能力

工作台通过抽象传输接口 `Transport`（`apps/mac/ui/infra/transport.ts`）解耦运行环境，并由 `bridged.ts` 与 `host.ts` 对接 macOS 宿主能力：

- **四条桥接信道（`apps/mac/ui/infra/bridged.ts`）**：
  1. `call(op, payload)`：将结构化 RPC 指令（经 `packages/protocol/src/client.ts` 类型化包装）异步发送至同进程 Rust 服务端并解包 `Envelope`。
  2. `state(listener)`：初始化读取当前最新 `StateFrame` 后持续监听 `host.on("frame:state")`，推动全局单向状态更新。
  3. `live(listener)`：接入实时高频增量流（如会话文本流、实时语音字幕、农机日志行）。
  4. `subscribe(name, payload, on, ended)`：建立按需可取消长订阅信道（终端状态、媒体理解任务、动态增量列表等）。
- **宿主桌面能力接口（`apps/mac/ui/infra/host.ts`）**：
  - 检测 `host.available() && host.params.view !== undefined` 自动切换为 `desktop` 宿主实现（否则回落至无宿主的 `browser` 兼容兜底，用于脱离 macOS 壳的单元测试与组件故事）。
  - 暴露的能力包括：系统命令行工具探测/安装/卸载（`commandLine`）、系统原生通知（`notify`）、状态栏摘要同步（`tray`）、应用主题与语言切换（`theme` / `locale`）、Finder 定位打开文件（`reveal`）、开场加载进度回传（`opening`）以及每秒轮询 Zod 校验后的原生应用自更新状态（`update`：`watch` / `check` / `install`）。

## 7.3 像素字与素材加工管线

VibeValley 的全部像素图与矢量图标在独立工程目录下管理并输出至根目录 `assets/`：

| 资产门类 | 源目录与加工工具 | 成品输出位置与消费方式 |
| --- | --- | --- |
| **2D 像素精绘、切图与提示词** | `design/pixel/`（`prompts/`、`process.py`、`straighten.py`、`title_layers.py`、`hd_batch.sh`）与 `design/assets/`、`design/art.sh` | 经纠偏、去杂与网格规整后沉淀到 `assets/pixel/`（配 `sprites.json` 记录逻辑宽高 `w/h`、足底锚点 `ax/ay` 与 `yard` 框）与 `assets/cursors/`（配 `cursors.json`）；工作台通过 `apps/mac/ui/infra/pixelManifests.ts` 直接引入 JSON 清单并从 `host.pixelDir` 加载 PNG |
| **像素字体** | `assets/fonts/`（`fusion-pixel-12px-proportional-zh_hans.otf` 与开源授权文本 `fusion-pixel-OFL.txt`） | 注册给 `nsh` 与 GPUI 的像素文字体名 `Fusion Pixel 12px Prop zh-Hans`，保证中英混排在整倍缩放下笔划锐利清晰 |
| **工作台线条图标与农机 Logo** | `apps/mac/ui/design/icons.ts`、`design/pixel/icons/`、`design/pixel/logos/` | `icons.ts` 内置 `reicon` SVG 路径集合（`<Icon name>`）；农机品牌与工具图标同时在像素目录维护静态切片供 `RuntimeIcon` 与像素农具栏消费 |
| **多端设计令牌生成与护栏** | `design/tokens.json`、`scripts/gen/tokens.ts`、`scripts/audit/ui-tokens.ts` | 从单源 `tokens.json` 生成并校验 `theme.json`、`nsh.json`、`theme_tokens.rs` 及 `global.css` 缓动曲线；`ui-tokens.ts` 对工作台与工作区外壳 `apps/mac/ui/{app,features,design,workspace}` 做 AST 扫描拦截硬编码色值、任意 Tailwind 类与裸控件 |

## 7.4 多密级测试场景与自动化验收报告管线

为避免真实端到端调试高成本以及盲测漏掉长文本、极端并发与深浅主题缺陷，UI 测试与截图验收采用**确定性真实核心状态注入 + 双端光栅核验**：

1. **核心状态 6 档密级生成器（`crates/core/src/scenario.rs`）**：
   - 使用 Rust 侧真实的 `Core::apply` 与 `reduce` 规则驱动 `ScenarioBuilder`（固定纪元时间 `SCENARIO_NOW`）构造 6 个真实密度快照（`Density`）：`Empty`（空引导）、`Minimal`（单主单）、`Typical`（常态多单与聊天）、`Dense`（高频并发）、`Extreme`（超长中文句子、长 URL、长 Commit SHA 等极端压力文本）与 `Edge`（异常与边界枚举组合）。
   - 导出固件确保工作台单元测试拿到的是与生产服务端**完全同源**的 `status`、`stage`、`moves`、`inbox`、`phaseText` 与 `view.plots`。
2. **工作台组件/交互/工作区套件（`apps/mac/ui/` & `scripts/audit/mac-tests.ts`）**：
   - 包含无头交互、主题令牌与外壳测试（`interactions.test.tsx`、`components.test.tsx`、`scenarios.test.tsx`、`theme.test.tsx`、`workspace/workspace.test.tsx`）。
   - `scripts/audit/mac-tests.ts` 并发驱动 `.tools/bin/nsh test` 执行工作台测试套件，解析每套用例通过/失败计数与耗时并生成结构化报告 JSON。
   - 真实 GPUI 窗口截图验收通过 `vp run ui:gallery` 统一驱动（`scripts/audit/ui-gallery.ts`），输出固定页面、工作区与农场的 Light/Dark/窄窗截图并校验 `dump.json` 零报错。
3. **像素场景无屏光栅自检与状态转储（`apps/mac/src/pixel/tests.rs` & `apps/mac/src/debug.rs`）**：
   - 像素测试直接在 CPU 上调用 `draw::raster` 生成实际 `RgbaImage` PNG（指定 `VIBEVALLEY_PIXEL_OUT` 可落盘查看），验证重叠帮工绘制顺序、点击命中盒与炭火地标对齐，不依赖图形显卡或屏幕窗口。
   - `debug.rs` 对外提供运行中窗口完整树与像素画布指标转储（缓存图片数、帧绘耗时 `last_paint_ms`、萤火虫采样坐标与点击事件历史 `taps`）。
4. **综合质量看板（`scripts/audit/ui-report.ts`）**：
   - 汇总 `mac-tests.ts` 结果、6+1（含英文 `en`）种情景密级枚举覆盖表、壳组件就绪与错误统计及各端截图对比画廊，输出单一离线 HTML 验收报告（默认目录 `/tmp/vv-ui-report`）。
