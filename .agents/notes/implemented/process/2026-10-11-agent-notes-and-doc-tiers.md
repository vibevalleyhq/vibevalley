# Agent Note: 决策记在 Agent Notes，文档只写现状

Status: implemented

## Problem

设计文档里混着现状、历史和理由：「2026-10-09 起换成农场」「本节留作对照」「还没做的」，一份 `heybro.md` 同时讲产品、服务端、协议、配置页、游戏性和开发计划。现状和历史搅在一起，读的人分不清哪句还算数；为什么这样做、放弃了什么，散在各处，一改文档就丢。

## Decision

照 [DeepSeek Harness 的 Agent Notes](https://github.com/deepseek-ai/deepseek-harness/tree/master/.agents/notes) 和它的文档分层：

- 决策和提案记成 Agent Note：`.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md`，规矩在 [.agents/notes/README.md](../../README.md)。正文写中文，机器检查的标记保持英文。
- 文档只写现状，每个事实一个家，别处链接过去：根目录 `AGENTS.md` 是常驻规矩，`docs/` 是当前的行为和约定（规矩在 `docs/AGENTS.md`），每个包的 README 是它的对外约定，理由在 Note。
- `bun run notes:verify` 检查 Note 的目录、文件名和格式，以及生成的清单 `CATALOG.md` 是不是最新（[Note 的目录由脚本生成](2026-10-15-notes-catalog.md)）；`bun run docs:verify` 还检查文档里的相对链接。

## Alternatives considered

**照 kico 的改法（类别写在 `Category:` 行，不分目录）。** 主人要的是照 DeepSeek 原版：类别也编进路径。

**一个 `decisions.md` 记全部决策。** 越写越长，改动挤在一个文件上，也分不清哪些还在提案。

**理由留在文档里。** 文档会被不断改成现状，理由跟着被删。

## Consequences

现状、理由、提案各有各的家，校验脚本兜底。代价是加一个非局部的改动要多写一篇 Note，挪文件时要跟着改 Note 里的路径。

macOS 的文件系统不分大小写：照搬 `docs/AGENTS.md` 时，它和原来的 `docs/agents.md`（帮工档案和农机的参考）是同一个文件，后者被覆盖过一次。参考文档因此改名 `docs/agents-and-runtimes.md`，`bun run docs:verify` 也检查链接的大小写和实际文件一致。
