# 第七篇：工程架构、跨平台接口与 Papertrails 资产管线

工作台代码与原生界面工程上围绕四个基座构建：`nsh` 运行时与响应式适配、桌面跨语言桥接、单源 Papertrails 资产同步链以及多密级自动化视觉验收管线。

## 7.1 `nsh` 运行时适配与响应式桥接

工作台 TSX 源码运行在 `nsh` 原生视图运行时（而非浏览器 DOM）之上，共享基座原语导出清单由 [primitives.md](docs/reference/primitives.md) 索引，并由两层轻薄适配桥接业务逻辑与原生底层：

| 模块 | 文件 | 核心机制 |
| --- | --- | --- |
| **Solid 2 响应式兼容层** | `apps/mac/ui/infra/solid.ts` | 由于 `nsh` 打包器拒绝直接打入 `solid-js`，`solid.ts` 直接基于 `nsh` 原生 `signal` / `computed` / `effect` / `context` 实现工作台所依赖的 `createSignal`、`createMemo`、`createEffect`（支持 Solid 2 的拆段副作用与 `{ defer: true }` 跳过首次执行）、`onSettled`、`createContext` 与 `useContext`；`equals: false` 选项通过外包 `{ v }` 盒对象绕过 `nsh` 默认的 `Object.is` 拦截，确保新切片推送必然触发对应域的下游依赖重算 |
| **宿主补丁与运行时垫片** | `apps/mac/ui/infra/polyfill.ts` | 为 `nsh` JavaScript 环境补充标准 Web 运行时能力缺口（如路径/正则/全局垫片），在页面与农庄手机入口顶部首个加载 |
| **条件热读取与双入口打包嵌入** | `apps/mac/build.rs` | 自动寻址 `.tools/bin/nsh`（或 `NSH_BIN` / `PATH`），按双入口分别构建全量工作台 `App.tsx`（`ui/build`）与轻量壳窗格 `ShellApp.tsx`（`ui/build-shell`）及其 `capabilities.json`；在 **Debug** 构建中若产物已存在则直接从磁盘热读取（修改 TSX 无需重新编译 Rust 壳），而在 **Release** 构建或设置 `VIBEVALLEY_EMBED_UI` 时开启 `nsh build --release`，仅单份静态嵌入剥离调试信息的 `bundle.nshc` 字节码（`bundle.js` 置 0 字节 sentinel），运行时由 `apps/mac/src/hosted/mod.rs` 按 `is_workbench_view` 分别缓存与惰性装载 |

## 7.2 桌面桥接协议与宿主能力

工作台通过抽象传输接口 `Transport`（`apps/mac/ui/infra/transport.ts`）解耦运行环境，并由 `bridged.ts` 与 `host.ts` 对接 macOS 宿主能力：

- **四条桥接信道（`apps/mac/ui/infra/bridged.ts`）**：
  1. `call(op, payload)`：将结构化 RPC 指令（经 `packages/protocol/src/client.ts` 类型化包装）异步发送至同进程 Rust 服务端并解包 `Envelope`。
  2. `slice(kind, listener)`：按域订阅 `slice:<kind>`（`board`、`sessions`、`collab`、`inbox`、`ops`、`farm`）并监听 `host.on("frame:slice:<kind>")`，回发 `applied` 确认修订号，推动按域隔离的单向状态更新。
  3. `live(listener)`：接入实时高频增量流（如会话文本流、实时语音字幕、农机日志行）。
  4. `subscribe(name, payload, on, ended)`：建立按需可取消长订阅信道（终端状态、媒体理解任务、动态增量列表等）。
- **宿主桌面能力接口（`apps/mac/ui/infra/host.ts`）**：
  - 检测 `host.available() && host.params.view !== undefined` 自动切换为 `desktop` 宿主实现（否则回落至无宿主的 `browser` 兼容兜底，用于脱离 macOS 壳的单元测试与组件故事）。
  - 暴露的能力包括：系统命令行工具探测/安装/卸载（`commandLine`）、系统原生通知（`notify`）、状态栏摘要同步（`tray`）、应用主题与语言切换（`theme` / `locale`）、Finder 定位打开文件（`reveal`）、开场加载进度回传（`opening`）以及每秒轮询 Zod 校验后的原生应用自更新状态（`update`：`watch` / `check` / `install`）。

## 7.3 Papertrails 资产同步管线

全部原始素材、3D 纸雕编译脚本与生成管线存放在同级独立仓库 `vibevalley-assets` 中，经 `design/sync-assets.sh`（及 `design/diorama.sh`）仅同步轻量成品至根目录 `assets/` 与 `apps/mac/resources/`：

| 资产门类 | 源目录与同步脚本 | 成品输出位置与消费方式 |
| --- | --- | --- |
| **3D 纸雕场景（`diorama`）** | `vibevalley-assets` + `design/diorama.sh` | 同步 `manifest.json`、`meshes.bin`、`lights.json`、`foley.json` 与 `print/`、`stock/` 贴图到 `assets/diorama/`，由 `vibevalley-diorama` 直接渲染 |
| **品牌、通道图标与开场画** | `vibevalley-assets` 仓（`render_brand.swift`）+ `scripts/gen/mac-branding.ts` + `design/sync-assets.sh` | 产出 `apps/mac/resources/{appicon-*.png,icon*.icns,dmg-background.png}`、`assets/icons/app-{32,64,256}.png` 与 `assets/brand/{opening-*.webp,tray-*.png}` |
| **角色头像与引擎徽标** | `vibevalley-assets` 仓（`build_avatars.py` / `build_engines.py`）+ `design/sync-assets.sh` | 同步至 `assets/avatars/`（14 角色、8 物种、6 主助手、用户与 1x/2x 导航肖像）及 `assets/engines/`（10 引擎 + 3 连接器）；工作台经 `apps/mac/ui/design/art.ts` 调 `host.assetsDir` 拼接 `file://` URL |
| **工作台线条图标** | `crates/rich/src/icon.rs`、`apps/mac/ui/design/icons.ts`、`scripts/gen/icons.ts` | 97 枚 `reicon` SVG 路径静态下沉至原生 `crates/rich/src/icon.rs`（`VvIcon`，无锁 `OnceLock<Vec<Path>>` 缓存）；TS 侧 `icons.ts` 仅保留纯类型 `IconName` 与 `actionIcon` 映射供 `<Icon name>` 调用，移动端与非 GPUI 载体经 `iconPaths.gen.ts` 矢量回退 |
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
3. **纸雕场景单测与状态转储（`apps/mac/src/diorama/` & `apps/mac/src/debug.rs`）**：
   - Rust 单元测试验证切片到地块阶段的映射、开场 WebP 缓存回收与 `vibevalley-diorama` 逻辑。
   - `debug.rs` 对外提供运行中窗口完整树与纸雕画布指标转储（`diorama` 字段含渲染器类型、时段、聚焦建筑、地块/偶人数与 GPU/回读遥测）。
4. **综合质量看板（`scripts/audit/ui-report.ts`）**：
   - 汇总 `mac-tests.ts` 结果、6+1（含英文 `en`）种情景密级枚举覆盖表、壳组件就绪与错误统计及各端截图对比画廊，输出单一离线 HTML 验收报告（默认目录 `/tmp/vv-ui-report`）。
