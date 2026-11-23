# Agent Note: 持久执行入口补齐、外部驱动实机验证与农场视觉对照

Status: proposed

## Problem

持久执行引擎（`crates/runtime/src/agent/durable/`、`crates/runtime/src/agent/codemode/`）、运行时告警并入 `InboxSlice` 与八个 Go 基线外部驱动的离线回放均已上线（见 [核心状态](docs/subsystems/core.md)、[VibeValley 自己的 agent](docs/subsystems/brain.md)、[帮工](docs/subsystems/session.md)），仍余三项实机与产品入口缺口：

1. **六家外部驱动实机覆盖不足**：除 Claude Code、Codex 与本机 Antigravity ACP 握手外，OpenCode、Grok、Kimi、CodeBuddy、Qwen Code、Qoder 的真实厂商 CLI 计费、配额、插话/取消、工具类别与跨版本账号恢复尚未逐家实测。
2. **持久执行产品入口待补齐**：原生界面尚无手工压缩入口；普通助手或帮工对话尚无触发 CodeMode 脚本任务的入口；真实厂商侧取消计费与预算恢复待在线核对。
3. **完整农场近像素视觉验收未完成**：尚未在固定状态、昼夜时刻、1280×800 与窄窗条件下对原 Web 农场基线（`perf/platform-simplification@a2c1851ab` 的 `apps/web/src/farm`）与 GPUI 农场窗口完成逐面板、逐状态像素对照验收。

## Proposal

### 一、外部驱动实机验收缺口

| 驱动 | 离线已覆盖 | 尚待真实 CLI 核对 |
|---|---|---|
| OpenCode | 本机 ACP 握手、模拟 CLI 开轮与通用队列 | 真实 CLI 插话、取消、计费配额与跨版本恢复 |
| Grok | 本机 ACP 握手、模拟 CLI 开轮与缺基线续接 | 厂商独有工具类别、真实插话、取消与配额 |
| Kimi | 本机 ACP 握手、模拟 CLI 开轮与排队 | 厂商独有工具类别、真实取消与配额 |
| CodeBuddy | 模拟 CLI 开轮、排队与回放 | 本机安装真实 CLI 后的完整开轮、工具与恢复 |
| Qwen Code | 模拟 SDK `initialize`、开轮与用量 | 本机真实 CLI 工具类别、续接后上下文与真实用量 |
| Qoder | 模拟 SDK 开轮、工具事件通路与 `--resume` 参数 | 本机真实 CLI 工具类别、用量字段与续接后上下文 |

### 二、持久执行未完产品入口与在线核对

| 范围 | 已有实现 | 尚待补齐或实测 |
|---|---|---|
| 压缩 | `crates/runtime/src/agent/core/pipeline.rs` 与 `compaction/` 含手工、软/硬阈值与溢出四级 | 原生界面触发手工压缩；真实模型触达各阈值行为 |
| CodeMode | `crates/runtime/src/agent/codemode/`（QuickJS）与执行引擎已注册并通过回放 | 普通助手或帮工对话创建 CodeMode 脚本任务的入口 |
| 取消与预算 | 调度器级联取消、预算暂停与 `budget.raise` 已通过离线回归 | 真实厂商请求何时停止计费及厂商账单核对 |

### 三、完整农场视觉对照验收

以 `perf/platform-simplification@a2c1851ab` 的 Web 农场窗口为参照，固定 1280×800 与窄窗基线，核对仓库群岛与院子、日夜与帮工、工具栏、悬停命中、播种、工单与收获、成就、手机来电、聊天与小游戏：

- 整图与各命名区域 SSIM ≥ 0.985。
- RGB 最大通道差超过 12 的像素 ≤ 2%。
- 边缘 F1 ≥ 0.97（容差 1 个逻辑像素）。
- 32×32 逻辑像素窗口（步长 16）每块中 RGB 最大通道差超过 12 的像素 ≤ 8%。

## Alternatives considered

**只依赖 Go 基线离线回放而不做实机 CLI 核对**：厂商 CLI 迭代会修改用量字段与取消时序，仅靠离线样本无法发现线上账号恢复与计费差异。

**整套替换工单板为通用调度器**：保留工单板调度、仅把内置生成与治理接入持久执行，避免同一轮工作被双层认领。

## Acceptance criteria

- 六家 ACP / SDK 驱动完成真实 CLI 实机验证（或记录明确放弃的驱动），实测结论沉淀进 [档案、农机和技能书](docs/subsystems/agent.md) 与 [帮工](docs/subsystems/session.md)。
- 原生界面支持手工触发压缩；确定 CodeMode 是否向普通对话开放并完成对应入口或明确裁剪。
- 完整农场在 1280×800（昼夜）与窄窗下通过上述视觉与交互阈值，或经评审由其他视觉方案取代。
- 全部完成后删除本 Note。

## Risks

- 外部厂商 CLI 版本更新可能改变 ACP/SDK 协议字段，实机验收需记录具体 CLI 版本号并保留脱敏回放样本。
- SQLite 提交与外部命令执行之间存在崩溃窗口，需继续依赖调用 ID、工作目录核对标记与工具可重放声明（[副作用中断回归](crates/runtime/src/agent/tests.rs)）。
