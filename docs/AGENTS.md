# AGENTS.md：文档的规矩

本文定义文档放在哪、怎么写。约定照 [DeepSeek Harness 的文档规矩](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md)，按 VibeValley 的大小删减；理由见 [agent-notes-and-doc-tiers](docs/subsystems/process.md)。[Agent Notes](.agents/notes/README.md) 的格式由它自己的 README 管，不在本文范围内。

## 一个事实一个家

每个事实只放在负责它的那一层，别处链接过去。

| 层 | 负责 | 不放 |
|---|---|---|
| 根目录 [AGENTS.md](AGENTS.md) | 常驻规矩：每次会话都要放在上下文里的规则，一到三行一条，链接到它的家 | 故事、例子、一次性的步骤、从别处抄来的内容 |
| 子目录 `AGENTS.md`（本文、`.agents/notes/README.md`） | 只对那个子目录的规矩 | 根目录已经有的 |
| [README.md](docs/README.md) | 唯一的手工文档地图和用语表 | 文档内容本身、另一份子系统或参考清单 |
| 教程：[guide.md](docs/guide.md)、[development.md](docs/development.md) | 照着做走到一个结果：使用、开发、素材生成和切图 | 完整的清单和表（链接到参考）、理由 |
| [architecture.md](docs/architecture.md) | 按顺序的地图：分层、核心状态、事件流、接口和存储；改 `apps/`、`packages/` 之前读 | 各子系统的细节、决策理由 |
| `subsystems/` 下的各篇（[写法](docs/subsystems/README.md)） | 一个子系统沉淀下来的样子，从架构的角度：边界、在哪、模型和不变量、流程、和谁打交道、为什么这样、放弃了哪些路 | 教学步骤（→ 教程）、过程和日期、计划（→ 提案）、另一份子系统索引 |
| [concepts.md](docs/concepts.md) 和 `reference/` 下的各篇 | 概念，和查的东西：还没拆成子系统的行为、生成的表（[capabilities.md](docs/reference/capabilities.md)）、界面清单（[farm-ui.md](docs/reference/farm-ui.md)） | 子系统已经写了的（→ 链接过去）、教学步骤、理由、计划 |
| `style/` 下的各篇（[code.md](docs/style/code.md)、[writing.md](docs/style/writing.md)） | 代码和文字怎么写 | 某个子系统的行为 |
| [Agent Notes](.agents/notes/README.md) | 具体的计划：要做什么、怎么做、怎么算做完；做的过程里的决定 | 做完以后仍然成立的（→ 沉淀进子系统，Note 删掉） |
| 包的 README（`apps/server/README.md`、`apps/web/README.md`、`apps/desktop/README.md`、`packages/*/README.md`、`site/README.md`） | 这个包的对外约定：管什么、导出什么、依赖谁、不变量、测试 | 别的包的事、代码注释的复述 |
| 代码注释（[写法](docs/style/code.md#注释)） | 这段代码的约定和不显然的约束 | 推理过程、测试流程、远处的行为、概述和历史 |

`docs/` 里只放文档：教程、子系统、参考和写法。子系统的「为什么这样」就是沉淀下来的理由；还没做的大事和正在做的计划 → `proposed/` Note。包的约定 → 包 README；常驻规矩 → 根目录 `AGENTS.md`，附上理由的链接。

每篇文档要么是教程，要么是参考：教程按顺序带人走到一个结果，每一步只讲这一步要的；参考按主题查，写现在的行为，不讲顺序。两种内容都有时分开写，小的那部分加标题标明。

## 怎么写

- **只写现状。** 历史在 git 里；文档里不写「2026-10-09 起」「以前」「以后」。还没做的事链接到它的提案（子系统的「还没做的」一节只放这种链接）。
- **改代码的同一个改动里改文档**：受影响的参考文档、包 README 和注释一起改；改了决策就改它的 Note（[什么时候写](.agents/notes/README.md#什么时候写)）。
- **用农场的叫法**（[用语表](docs/README.md#用语)）；代码名第一次出现时加上。
- **直接写**：说清是谁、做什么、什么时候、出错怎样。不写推理过程，不复述代码。
- **链接从仓库根写**：`[工单](docs/subsystems/issue.md)`，不写 `../`、`./`，也不以 `/` 开头（读起来像磁盘上的绝对路径）；一个文件不管从哪链过去都是同一个写法，挪了它搜一个字符串就能改完。`bun run docs:verify` 拒绝别的写法，并检查它们都能打开。
- **怎么写**照 [style/writing.md](docs/style/writing.md)：用中文写，结论和证据在前，一件事只写在一处，用用语表里的词。

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
bun run docs:verify     # 文档地图覆盖，加上所有 Markdown 里的链接（从仓库根写）
```
