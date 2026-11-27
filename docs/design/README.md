# VibeValley 设计系统与界面架构全景

VibeValley 在同一套核心状态与协议之上提供两张视觉皮肤，并分布于五个渲染载体中：工作台负责高信息密度的工程协作与配置，Papertrails 纸雕农场负责实景化空间感知与轻交互。

## 双皮视觉定位与职责划分

| 皮肤 | 主场 | 职责 | 字体与色彩基准 |
| --- | --- | --- | --- |
| **田间工作台** | 主工作区、工单、频道、运行中心、设置、素材库、笔记 | 承载全部精细操作、状态检索、审阅与配置 | 系统界面体（PingFang SC）、等宽体（Menlo / Maple Mono NF CN），暖米纸浅色与深褐黑深色双主题 |
| **Papertrails 纸雕农场** | 3D 纸雕江南院落、开场欢迎画、农场手机 | 将核心状态、地块进展与来电映射为可点按、可掀顶的 3D 纸雕场景 | 系统界面体（PingFang SC），不随工作台浅/深主题切换的棉纸暖棕调色板与动态昼夜光影 |

两套皮肤在状态与交互层严格解耦：核心状态经 5 域切片（`board`、`sessions`、`collab`、`inbox`、`ops`）与独立 `FarmFrame`（`farm`）单向推入各端，农场的地块与建筑点按最终转回通用路由跳转或服务端指令，工作台不直接渲染场景逻辑，3D 纸雕绘制也不复用工作台业务组件。

## 五大界面渲染载体

| 载体 | 技术栈 | 代码位置 | 样式与令牌来源 |
| --- | --- | --- | --- |
| **工作台 Hosted Views** | `nsh` + Solid 2 兼容层 + Tailwind 令牌引擎 | `apps/mac/ui/{app,features,infra}/`、`apps/mac/ui/farm/` | `apps/mac/ui/design/theme.json`、`apps/mac/ui/nsh.json` |
| **原生应用外壳与 3D 纸雕场景** | Rust GPUI + `wgpu`/WGSL 纸雕渲染引擎 | `apps/mac/src/`、`apps/mac/crates/diorama/` | `apps/mac/src/theme.rs`、`assets/diorama/`、`assets/brand/` |
| **宿主集成面** | `nsh` 基础元素 + Tailwind 令牌 class（复用 `design` 原语与 `workspace/chrome.tsx`） | `apps/mac/ui/workspace/`、`apps/mac/ui/App.tsx` | `apps/mac/ui/design/theme.json`、`apps/mac/ui/nsh.json` |
| **刘海灵动岛** | Swift `NSPanel` + AppKit / SwiftUI | `apps/island/Sources/VibeValleyIsland/Island.swift`、`apps/island/Sources/IslandCore/Geometry.swift` | 内部硬编码暖棕色与状态四色（[横向差异审计](docs/design/09-design-system-audit.md)） |
| **官网静态站点** | Vite + Solid 2 + Tailwind CSS v4 | `apps/site/` | `apps/site/src/ui/global.css` |

## 章节总览

| 篇目 | 文档 | 覆盖范围 |
| --- | --- | --- |
| 总览 | [README.md](docs/design/README.md) | 双皮职责、五大渲染载体与全篇索引 |
| 第一篇 | [01-philosophy-and-tokens.md](docs/design/01-philosophy-and-tokens.md) | 十条设计哲学、表面色阶、语义四色、圆角矩阵、边框阴影、字体图标梯级与动效曲线 |
| 第二篇 | [02-atomic-components.md](docs/design/02-atomic-components.md) | 按钮、表单、开关、状态标签、弹窗表格分栏、领域原子与外壳组件对照 |
| 第三篇 | [03-conversation-and-work-streams.md](docs/design/03-conversation-and-work-streams.md) | 频道消息流、斜杠指令 Composer、运行中心 `/runs` 与瀑布轨迹、工单看板、档案与额度 |
| 第四篇 | [04-motion-and-pixel-rendering.md](docs/design/04-motion-and-pixel-rendering.md) | 工作台微交互、3D 纸雕渲染（`wgpu`/WGSL）、昼夜光影、掀顶切面与偶人寻路物理 |
| 第五篇 | [05-audiovisual-and-artifacts.md](docs/design/05-audiovisual-and-artifacts.md) | 音频独占租约与 PCM/语音通话、程序化音效合成、素材库与灯箱、双轨分栏、Note 笔记、原生 Diff/文件/终端链接 |
| 第六篇 | [06-desktop-architecture-and-topology.md](docs/design/06-desktop-architecture-and-topology.md) | macOS 多载体拓扑、全量场景与工作台页面清单、单向状态与显式 FSM、响应式降级、键位上下文与容灾 |
| 第七篇 | [07-engineering-config-and-assets.md](docs/design/07-engineering-config-and-assets.md) | `nsh` Solid 适配层、桌面桥接与 `LateServer`、Papertrails 资产管线、6 档密级场景与 UI 验收报告 |
| 第八篇 | [08-agent-ui-guide.md](docs/design/08-agent-ui-guide.md) | Agent 编写与评审工作台/外壳/官网界面的硬约束、反模式与提交前自查清单 |
| 第九篇 | [09-design-system-audit.md](docs/design/09-design-system-audit.md) | 五载体令牌差异矩阵、双源组件并存、手绘图形与手搓控件、轨迹比例与静态检查缺口 |
