# Agent Note: pi 打磨好之后接回其他 runtime

Status: proposed

## Problem

农场目前已跑通 `vibevalley`、`pi`、`claude`、`codex` 与 `dsh` 农机（[档案和农机](docs/subsystems/agent.md)、[帮工](docs/subsystems/session.md)）。注册表中的 `opencode`、`grok`、`kimi`、`antigravity` 与 `cursor` 虽各有擅长场景与独立订阅额度，但尚未逐一完成端到端实机验证与差异适配。

## Proposal

按 `claude` 与 `codex` 的接入标准逐台启用并打通以下环节：
1. **探测与登录**：核对安装探测、模型列表读取与额度/套餐窗口显示（套餐制农机按时间窗口计量，不按美元单价计费）。
2. **会话与工具接入**：验证系统提示注入、中途插话 `steer`（不支持插话的农机自动排入下一轮）、`/mcp` 工具挂载（不支持 MCP 的农机提供 CLI 汇报与说话命令）及回合末用量结算时机。
3. **文档与模板沉淀**：每打通一台，将其支持项写入 `presets.json`，将探测与会话差异沉淀进 [档案和农机](docs/subsystems/agent.md) 与 [帮工](docs/subsystems/session.md)。

## Alternatives considered

- **一次性全部放开**：多台未验证农机同时暴露会让派活频繁踩中未适配的命令或汇报边界。

## Acceptance criteria

- 每台新启用农机均可在真实项目 worktree 中完成改代码、跑测试、调用 `issue_report` 汇报并合入主分支。

## Risks

- 部分农机不支持系统提示或中途插话，人设需拼入首轮任务说明，追问需排队至下一轮。
