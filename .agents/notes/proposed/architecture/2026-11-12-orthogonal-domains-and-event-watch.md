# Agent Note: 会话执行策略解耦与透明归属（`Session.scope`）

Status: proposed

## Problem

在 `#251` 完成 `Channel` 纯聊天化、`Watch` 事件观察层抽离及工单蓄水与交付迁回 `Issue` 后（见 [频道](docs/subsystems/channel.md)、[帮工](docs/subsystems/session.md)、[工单](docs/subsystems/issue.md)、[观察](docs/subsystems/watch.md)），`modules/session` 已不再导入 `Channel` 或 `Issue`，但协议与内部生命周期仍保留最后一层隐式工单耦合：

- **协议 `T.Session` 仍直接携带 `issue`、`refining` 与 `LastRun.answer`**：[session/shapes.ts](packages/protocol/src/session/shapes.ts) 把上层工单归属写进会话形状，而非通用透明归属标识。
- **`Session` 内部仍按「是否在做工单」硬编码 5 处执行策略**：工作目录选检出还是上下文目录、系统提示给哪套工作规矩、是否接受 `issue_report`、满员腾位时 `dismiss` 还是 `suspend`（[lifecycle.ts](apps/server/src/modules/session/lifecycle.ts)）、轮末无待处理输入时是否自动歇下（[watch.ts](apps/server/src/modules/session/watch.ts)）。

## Proposal

1. **显式执行策略（`SessionPolicy`）**：开工（`hireWith`）时由调用方（`Issue` 或 `Watch`）显式传入工作目录模式、满员腾位动作（`dismiss | suspend`）、轮末休眠策略与结构化汇报开关，持久化进 `session` 行；`modules/session` 内部只读策略字段，不再读取 `issue` 或 `refining`。
2. **透明归属字段（`scope`）**：将协议 `T.Session` 的 `issue`、`refining` 收敛为透明归属 `scope?: { kind: "issue" | "draft" | "channel" | "duty"; id: string }`，将 `IssueAnswer` 迁回 `packages/protocol/src/issue/`，同步更新页面与 CLI 读法。

## Alternatives considered

- **不抽离执行策略，只把 `issue` 改名成 `scope: { kind: "issue" }`**：只是把相同的工单分支藏进字符串标签，并未消除 `Session` 对上层业务生命周期的假设。

## Acceptance criteria

- `modules/session` 生产代码不再按工单或起草身份分支，全部由开工时的 `SessionPolicy` 决定；[modules.test.ts](apps/server/src/modules.test.ts) 增加静态门禁守住。
- `packages/protocol/src/session/` 不再包含 `issue`、`refining` 或 `IssueAnswer`；`vp run server:check`、`vp run web:check`、`vp run docs:verify` 全绿，更新 [帮工](docs/subsystems/session.md) 后删除本 Note。

## Risks

- **表结构与跨端契约同步变更**：新增策略持久化字段与调整 `T.Session.scope` 会触发本机 PGlite 按哈希自动归档重建，需在一次提交中同步更新服务端投影、工作台、像素农场与 CLI。
