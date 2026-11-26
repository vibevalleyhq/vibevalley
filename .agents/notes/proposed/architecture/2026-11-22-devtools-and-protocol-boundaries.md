# Agent Note: VibeValley DevTools V2

Status: proposed

## Problem

DevTools V1（`DebugKit` 契约、四泳道环形缓冲、`FaultGate`、`HostDebugBridge`、悬浮胶囊与 6 视图 `HostedView("devtools")`）与跨边界协议化准则已落地并沉淀至 [核心状态](docs/subsystems/core.md)、[客户端](docs/subsystems/app.md) 与 [地基](docs/subsystems/foundation.md)。目前仍余四项 V2 调试能力与旧调试钩子退役未完成：

1. **缺少画布 `Inspector`**：无法在应用内点选画布元素直接查看 `testID`、布局边界框与源码位置。
2. **Trajectory 联动与导出不足**：Trajectory 尚不能与 Timeline 双向定位、展开子代理嵌套树或一键导出脱敏轨迹供 `vibevalley-eval` 离线复现。
3. **缺少 Loro 运行态检视**：`State & Cache` 视图尚未接入 Loro 文档前沿与 `EphemeralStore` 在线态视图。
4. **旧调试钩子并存**：[debug/script.rs](apps/mac/src/debug/script.rs) 仍维护 1 秒定时整份 dump 与非类型化的 `VIBEVALLEY_DEBUG_SCRIPT` 文本脚本。

## Proposal

在现有 `DebugKit`（[debug.rs](crates/protocol/src/contract/debug.rs)）与 `HostedView("devtools")`（[DevToolsApp.tsx](apps/mac/ui/features/devtools/DevToolsApp.tsx)）之上补齐 V2 能力并退役旧脚本入口：

| 项 | 负责内容 |
|---|---|
| **画布 `Inspector`** | 点选画布高亮 `testID` 与布局边界框、查看关联托管视图状态与修订号、一键跳至对应 `.tsx` 或 `.rs` 源码 |
| **Trajectory 进阶联动** | Trajectory 与 Timeline 双向定位、子代理嵌套树钻取、一键导出脱敏轨迹供 `vibevalley-eval replay` / `inspect` 复现 |
| **Loro 状态检视** | 在 `State & Cache` 中接入 Loro 文档前沿与 `EphemeralStore` 在线态视图 |
| **退役旧调试钩子** | 用强类型 `DebugCommand` 替换 [debug/script.rs](apps/mac/src/debug/script.rs) 的 1 秒定时整份 dump 与非类型化 `VIBEVALLEY_DEBUG_SCRIPT` 文本脚本 |

## Alternatives considered

**继续扩展 [debug/script.rs](apps/mac/src/debug/script.rs) 的文本脚本**：非类型化命令字随着交互与浮层增多难以维护，无法直接表达点选元素与结构化断言。

**另起独立调试协议**：已有 `DebugKit` 覆盖了 `VIBEVALLEY_DEBUG=1` 门禁、脱敏器与 `HostDebugBridge`，直接在 `DebugKit` 上扩充 V2 能力成本最低。

## Acceptance criteria

- 画布 `Inspector` 可命中 `testID` 并跳至源码；`State & Cache` 展示 Loro 前沿与 `EphemeralStore`；Trajectory 支持与 Timeline 双向定位、子代理树展开及导出供 `vibevalley-eval replay` / `inspect` 复现。
- 原有 `VIBEVALLEY_DEBUG_SCRIPT` 验收用例全部迁至强类型 `DebugCommand`，并移除 [debug/script.rs](apps/mac/src/debug/script.rs) 的旧脚本与定时 dump 路径。
- 完成后沉淀进 [客户端](docs/subsystems/app.md) 与 [核心状态](docs/subsystems/core.md) 并删除本 Note。

## Risks

- V2 验收迁移期间新旧调试脚本并存可能制造双路径维护负担：待强类型 `DebugCommand` 落地后一次性切换验收脚本并删除旧路径。
