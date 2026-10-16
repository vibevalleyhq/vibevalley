# Agent Note: pi 打磨好之后接回其他 runtime

Status: proposed

## Problem

现在用 VibeValley 自己的 agent、pi、claude 和 codex（[pi-only-for-now](../../implemented/simplification/2026-10-10-pi-only-for-now.md)、[claude-and-codex](../../implemented/feature/2026-10-11-claude-and-codex.md)）。opencode、grok、kimi、antigravity、cursor 各有长处，也有各自的订阅额度可以用；代码都还在，但没有一种真正跑通过。

## Proposal

照 claude 和 codex 的做法，逐个启用、逐个跑通：登录、模型列表、额度、插话、汇报、失败分类、花费（有套餐的按窗口，不按钱），以及用量什么时候报（claude 只在一轮结束时报，汇报因此要等这一帧处理完）。每接通一个，把它的差异记进 [agents-and-runtimes.md](../../../../docs/agents-and-runtimes.md)「在用的农机」的对照表，种子里给它一个档案。

## Alternatives considered

**一次全部打开。** 回到同时照顾八种、哪种都不好的局面。

## Acceptance criteria

每种 runtime 各有一个帮工在真实项目里改代码、跑通测试、提交、被收获。

## Risks

- 有的 runtime 不接受系统提示或禁用工具，人设只能写进工单开头。
- 不能插话的（kimi、antigravity）带话只能排到这一轮之后。
- 每家的账户都要付费或登录。
