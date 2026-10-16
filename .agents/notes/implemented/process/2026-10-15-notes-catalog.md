# Agent Note: Note 的目录由脚本生成，检查跑在 Bun 上

Status: implemented

## Problem

七十多篇 Note 分在生命周期和类别两层目录里。想知道「有没有记过某个决策」「最近定了什么」，只能一层层翻目录，或者猜关键词搜；标题在文件第一行，光看文件名看不全。原来的规矩不许建 `INDEX.md`：手写的清单会和路径、标题对不上，不相关的改动还会挤在同一个文件上。缺一份总览，又不能是手写的。

## Decision

- `.agents/notes/CATALOG.md` 由 `scripts/agent-notes.ts` 写：按生命周期、类别列出每篇 Note 的日期和标题（`# Agent Note:` 那一行），新的在前，否决的带上理由。它只来自路径和标题，不手改。
- `bun run notes:catalog`（脚本的 `--write`）重写它。`bun run notes:verify` 照样检查每篇 Note 的位置和格式，再拿应有的目录和文件比，不一样就报错，过期的目录过不了检查。合并时它冲突了，重新生成就行。
- 手写的 `INDEX.md` 仍然不许有：清单只有这一份生成的。
- 脚本跑在 Bun 上（`Bun.Glob`、`Bun.file`），根目录 `package.json` 的命令写成 `bun run …`，`scripts/doc-links.ts` 也用 Bun 跑。Node 只剩 `server/tool` 的两个脚本。

这一篇改了[决策记在 Agent Notes](2026-10-11-agent-notes-and-doc-tiers.md)里「目录本身就是清单，不另建 `INDEX.md`」那一条。

## Alternatives considered

**照旧，只靠目录和搜索。** 什么都不用维护，但要总览就得翻两层目录。

**手写 `INDEX.md`。** 正是原来不许的理由：会和路径、标题对不上，改动挤在一个文件上。

**目录写进 README 的一节。** README 是手写的规矩，生成的部分夹在里面，重新生成时得小心只换那一节；单独一个文件，整份重写就行。

**每篇 Note 加一行摘要，目录里列出来。** 目录会更好读，但每篇 Note 多一个要维护的字段，格式检查也要跟着改。标题已经说得清，先不加。

**脚本继续用 Node 跑。** Node 24 也能直接跑 TypeScript，但主人要用 Bun；Bun 自带 glob 和文件读写，脚本不用别的依赖。

## Consequences

- 加、挪、删一篇 Note 或改了标题，要多跑一次 `bun run notes:catalog`；忘了的话 `bun run docs:verify` 会拦下。
- 根目录的命令要装 Bun。`npm run …` 也还能用，它调起的仍是 `bun`。
- 目录只有日期和标题：要知道一篇 Note 说了什么，还得点进去。
