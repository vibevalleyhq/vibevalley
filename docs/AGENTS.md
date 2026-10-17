# AGENTS.md：文档的规矩

本文定义文档放在哪、怎么写。约定照 [DeepSeek Harness 的文档规矩](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md)，按 VibeValley 的大小删减；理由见 [agent-notes-and-doc-tiers](../.agents/notes/implemented/process/2026-10-11-agent-notes-and-doc-tiers.md)。[Agent Notes](../.agents/notes/README.md) 的格式由它自己的 README 管，不在本文范围内。

## 一个事实一个家

每个事实只放在负责它的那一层，别处链接过去。

| 层 | 负责 | 不放 |
|---|---|---|
| 根目录 [AGENTS.md](../AGENTS.md) | 常驻规矩：每次会话都要放在上下文里的规则，一到三行一条，链接到它的家 | 故事、例子、一次性的步骤、从别处抄来的内容 |
| 子目录 `AGENTS.md`（本文、`.agents/notes/README.md`） | 只对那个子目录的规矩 | 根目录已经有的 |
| [README.md](README.md) | 文档地图和用语表 | 文档内容本身 |
| 教程：[guide.md](guide.md)、[development.md](development.md) | 照着做走到一个结果：使用、开发 | 完整的清单和表（链接到参考）、理由 |
| [architecture.md](architecture.md) | 按顺序的地图：分层、核心状态、事件流、接口、存储、配置；改 `server/`、`app/` 之前读 | 各包的细节、决策理由 |
| [concepts.md](concepts.md) 和 `reference/` 下的各篇 | 一个子系统现在的行为和约定 | 教学步骤（→ 教程）、理由（→ Note）、历史、计划 |
| `style/` 下的各篇（[code.md](style/code.md)、[writing.md](style/writing.md)） | 代码和文字怎么写 | 某个子系统的行为 |
| [Agent Notes](../.agents/notes/README.md) | 决策：为什么、放弃了什么、怎么验证；提案 | 现在的行为说明（→ 文档）、上线后的计划和待办 |
| 包的 README（`server/README.md`、`app/README.md`、`site/README.md`） | 这个包的对外约定：管什么、导出什么、依赖谁、不变量、测试 | 别的包的事、代码注释的复述 |
| 代码注释（[写法](style/code.md#注释)） | 这段代码的约定和不显然的约束 | 推理过程、测试流程、远处的行为、概述和历史 |

`docs/` 里只放文档：教程、参考和写法。设计过程里的东西不放这里：理由 → Note；还没做的大事 → `proposed/` Note；风险和取舍 → 它所属决策的 Note。包的约定 → 包 README；常驻规矩 → 根目录 `AGENTS.md`，附上理由的链接。

每篇文档要么是教程，要么是参考：教程按顺序带人走到一个结果，每一步只讲这一步要的；参考按主题查，写现在的行为，不讲顺序。两种内容都有时分开写，小的那部分加标题标明。

## 怎么写

- **只写现状。** 历史在 git 和 Note 里；文档里不写「2026-10-09 起」「以前」「还没做」「以后」。还没做的事链接到它的提案。
- **改代码的同一个改动里改文档**：受影响的参考文档、包 README 和注释一起改；改了决策就改它的 Note（[什么时候写](../.agents/notes/README.md#什么时候写)）。
- **用农场的叫法**（[用语表](README.md#用语)）；代码名第一次出现时加上。
- **直接写**：说清是谁、做什么、什么时候、出错怎样。不写推理过程，不复述代码。
- **相对链接**：链接仓库里的文件用相对 Markdown 链接，`bun run docs:verify` 会检查它们都能打开。
- **怎么写**照 [style/writing.md](style/writing.md)：用中文写，结论和证据在前，一件事只写在一处，用用语表里的词。

## 检查清单

改文档时顺手找这些：

- 同一条规则写在两处：留一处，另一处改成链接。
- 历史或状态写在了参考文档里（「已实现」「将来」「状态：」）：改成现状，链接 Note 或提案。
- 手抄的清单（接口、字段、环境变量、测试列表）和代码对不上：以代码为准，能链接就链接。
- 一段塞了好几条规则：拆开。
- 到处加粗：只给改变行为的那一句。
- `implemented/` Note 里还有「应该」「计划」「验收」：改成上线的样子。

## 检查命令

```bash
bun run notes:verify    # Agent Notes 的目录、文件名、格式，CATALOG.md 是否最新
bun run notes:catalog   # 加、挪、删 Note 或改了标题以后：重写 CATALOG.md
bun run docs:verify     # 加上文档里的相对链接
```
