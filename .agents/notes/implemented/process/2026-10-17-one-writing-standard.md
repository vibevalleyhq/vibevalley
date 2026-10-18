# Agent Note: 写作规范以信息密度为主，STE 只留词和格式

Status: implemented

## Problem

`docs/style/writing.md` 原来整篇照 ASD-STE100：一词一义、一句一事、每句不超过 50 字、一个名词前最多两个「的」、三项以上用列表。它管一句话会不会被读错，管不到一段话该不该有。2026-10-17 写的[方法论 Note](.agents/notes/implemented/process/2026-10-17-make-the-easy-thing-the-right-thing.md)和[能力提案](.agents/notes/implemented/architecture/2026-10-17-capabilities-before-surfaces.md)每句都合规，问题全在段落层：Note 把 `AGENTS.md` 的四层清单抄了一遍，同一条理由在 Proposal 和 Alternatives 里各写一遍，还有「最有用」「是关键」这类评价。

STE 的几条软规则还和信息密度相反：「一句一事」「每句不超过 50 字」把一个因果拆成几句，主语和连接词跟着重复；「三项以上用列表」把连着的推理切碎。

## Decision

`writing.md` 分两部分：

- **写什么、删什么**：主人给的研究写作标准（证据在前、解释只留机制、推论要有新信息、删除测试、一件事只写在一处）。管全部文字，包括给主人的回复。
- **词和格式**：STE 里给 agent 读的文字离不开的几条硬规则：用语表、要求强弱的固定词、步骤格式、警告、标点。

去掉的：一句一事、句子长度、「的」的个数、三项用列表、「硬规则全守，软规则做到八成」。

## Alternatives considered

**两套都留，宏观的另起一篇。** 在句子层两套方向相反（一句装下完整事实 vs 一句一事），并存时写的人要自己裁决，等于没有规范。

**整篇换成研究写作标准，STE 全删。** `AGENTS.md`、skill 里「应」和「宜」分不清、同一个东西换着叫，agent 会读错；研究写作标准不管这些。

## Consequences

- Note、提案、报告、对话里的结论都要过删除测试；按新规范改方法论 Note 和能力提案是下一步。
- skill 的步骤仍然一步一条，删除测试只管步骤之间的解释。
- 这条写不成检查，属于 [让容易的写法就是对的写法](.agents/notes/implemented/process/2026-10-17-make-the-easy-thing-the-right-thing.md) 的第 3 层。

## Verification

- `bun run docs:verify` 通过。
- `docs/AGENTS.md` 和 `docs/README.md` 对 `writing.md` 的描述跟着改了，不再写「一句一事」。
