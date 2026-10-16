# Agent Note: 先把 pi 打磨好，再逐个接回别的 runtime

Status: implemented

## Problem

oar 能驱动八种 runtime，种子里的七个帮工档案分在 claude、codex、grok、kimi、antigravity、pi 上。每一种的登录、模型列表、额度读法、参数限制和失败方式都不一样；同时照顾八种，哪一种都打磨不好，还要为每家的账户付钱。

## Decision

先把 pi 这一条路打磨好（主人 2026-10-10 定）：

- 七个种子档案都改到 pi 上（`server/internal/protocol/seeds.json`），模型跟「农具」页里 pi 的默认模型走（DeepSeek V4.1 Flash）；去掉了只为别的 runtime 写的设置（「写进工单开头」的人设方式、禁用 `web_search`）。
- 主人现有的配置里，其他 runtime 在「农具」页里停用；停用的不读额度，顶栏的精力瓶也不显示它们。
- 代码里多 runtime 的支持（参数限制、插话能力、额度读法）都保留，重新启用就能用。

档案名字里的 Kimi、Grok、反重力是当初对应的 runtime，没有改名（[agents-and-runtimes.md](../../../../docs/agents-and-runtimes.md)「种子档案」）。

pi 这条路打磨好以后，claude 和 codex 接了回来（2026-10-11，[claude-and-codex](../feature/2026-10-11-claude-and-codex.md)），各有一个种子档案；opencode、grok、kimi、antigravity、cursor 仍然停用，逐个接回（[other-runtimes](../../proposed/feature/2026-10-10-other-runtimes.md)）。

## Alternatives considered

**每种 runtime 都跑通一遍再继续。** 每家都要登录、付费、调参，打磨的精力被摊薄；放在 pi 打磨好之后（[other-runtimes](../../proposed/feature/2026-10-10-other-runtimes.md)）。

**删掉多 runtime 的代码。** 以后还要用；保留的代价只是几张对照表。

## Consequences

一个模型、一个账户、一种失败方式，问题好查，钱好算。代价是「五湖四海」（五种 runtime 的帮工都请过）这个成就暂时拿不到（它后来随 [成就和金币](../feature/2026-10-11-achievements.md) 拿掉了，现在数农机种数的是「物尽其用」）；档案的名字和它实际用的 runtime 对不上。
