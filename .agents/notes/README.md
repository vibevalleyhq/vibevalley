# Agent Notes

这里只放一种设计文档。一篇 **Agent Note** 是一份具体的计划：要做什么、为什么、放弃了什么、怎么算做完，和做的过程里定下的事。做完以后仍然成立的部分沉淀进 [子系统](../../docs/subsystems/README.md)（边界、模型、流程、为什么这样），Note 删掉；当前的行为和约定归 [docs](../../docs/README.md)，这里不复制接口、字段或清单。本文定义 Note 放在哪、什么时候写、文件格式。约定照 [DeepSeek Harness 的 Agent Notes](https://github.com/deepseek-ai/deepseek-harness/tree/master/.agents/notes)；正文写中文，需要机器检查的标记（`# Agent Note:`、`Status:` 和章节名）保持英文原样。

## 位置和命名

每篇 Note 有两个维度，都写在**路径**里：`{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`。

- **生命周期**（第一层目录）是 Note 的状态，状态变了就把文件挪到对应目录：
  - **`proposed/`**：实施前审过的提案，还没做（或只做了一部分）。
  - **`implemented/`**：决策已经上线、还没沉淀进子系统的。沉淀的时候把仍然成立的决定和放弃的路写进对应子系统的「为什么这样」，删掉这篇，把指向它的链接改指子系统。还没沉淀之前，文件记录决定了什么、否决了什么，并且**跟着上线的样子保持最新**：之后代码挪了文件、改了包名、改了某个键或默认值，同一个改动里更新这篇 Note（只改事实：路径、名字、结构，不改决策本身）。整个决策被后来的决策取代时删掉它，把仍然成立的部分并进接替它的 Note：不写「已被取代」的横幅，原文留在 git 里。
  - **`rejected/`**：考虑过、否决了。只在它的理由能防止一个诱人而实际的错误时保留，否则删掉。
- **类别**（第二层目录）是决策的种类，见下面「类别」。

文件名里的日期是这个话题**第一次提出**的日子。Note 之间互相引用用相对 Markdown 链接（`[题目](../../implemented/architecture/2026-…-….md)`），不用裸文字或编号，这样能机器检查，挪目录后也能修。

清单是 [CATALOG.md](CATALOG.md)：按生命周期和类别列出每篇 Note 的日期和标题，新的在前。它由 [scripts/agent-notes.ts](../../scripts/agent-notes.ts) 从路径和标题写成，不手改，也不另建手写的 `INDEX.md`：加、挪、删 Note 或改了标题以后跑 `bun run notes:catalog`，过期了 `bun run notes:verify` 会报错；合并时它冲突了不用手合，重新生成（[理由](implemented/process/2026-10-15-notes-catalog.md)）。

## 类别

类别是封闭的集合，以 [scripts/agent-notes.ts](../../scripts/agent-notes.ts) 为准，校验会拒绝其他目录。加一个类别要同时改那里和本节。

| 类别 | 管什么 |
|---|---|
| `feature` | 主人或模型能感知的新能力 |
| `bug-fix` | 修一个缺陷，或补上一次事故暴露的缺口 |
| `simplification` | 删掉代码、行为或范围，不加新能力 |
| `architecture` | 关于**上线的代码**的结构性决策：包之间的关系、运行时的用语 |
| `process` | 代码**周围**的工具、规矩和流程：检查、包管理、文档规矩，不是运行时行为 |
| `testing` | 测试设施和测试策略 |

`architecture` 和 `process` 的分界：前者是我们上线的代码本身，后者是围绕它的工具和流程。没有 `refactor` 类：它和 `simplification` 重叠，「可观察的行为变没变」已经能区分。

## 什么时候写

只为代码、测试和现有文档解释不了的、长期有效的决策理由，在同一个改动里新增或更新一篇 Note。对将来的大工作的提案从 `proposed/` 开始；已经做了的决定从 `implemented/` 开始。按决策的种类选类别目录。

更新已经拥有这个决策的 Note 就算满足要求，不要另起一篇重复的。机械的、局部的改动可以免写，包括局部的界面样式和交互调整。一篇 Note 不能被改成**另一个决策**：用一篇新的取代它，新的在 `## Alternatives considered` 里写明取代了哪一篇，旧的删掉。跟着代码更新 `implemented/` 里的事实（东西挪到了哪）是必须的，不算改决策。

## 文件格式

每篇 Note 都用同一个格式，`bun run notes:verify` 检查（[scripts/agent-notes.ts](../../scripts/agent-notes.ts)）。

### 开头

前三行固定是：

```markdown
# Agent Note: <标题>

Status: <状态>
```

后面空一行。`Status:` 只有三种写法，必须和所在的生命周期目录一致，校验会对照：

- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <一行理由>`

状态里不写日期，也不加括号说明：文件名里有第一次提出的日期，其余的在 git 里。被否决的理由是唯一带内容的状态，因为读者来看的就是这个结论。

### 正文

正文都以 `## Problem` 开头：动机，不看解决办法也能读懂。后面按生命周期用这些固定的章节名；确实特有的技术章节（数据形状、协议、目录结构）可以夹在必需章节之间。

`proposed/`：

```markdown
## Problem
## Proposal
……特有章节……
## Alternatives considered
## Acceptance criteria
## Risks
```

`## Proposal` 是打算做的改动，可以用将来时，计划、迁移步骤、待定问题都放这里。`## Acceptance criteria` 写做到什么可观察的状态算完。`## Risks` 写可能出什么问题，以及有意放弃了什么。

`implemented/`：

```markdown
## Problem
## Decision
……特有章节……
## Alternatives considered
## Consequences
```

`## Decision` 用现在时描述上线的样子，整篇跟着它保持最新。`## Consequences` 写这个取舍付出了什么、换来了什么。提案时期的章节在这里不允许出现，校验会拒绝：`## Proposal`、`## Task`、`## Migration task`、`## Acceptance criteria`。写现状的 `## Verification`、`## Deferred`、`## Related` 可以有。

`rejected/`：就是冻结的提案，保留提案时的章节，结论写在 `Status:` 行。只要求开头、`## Problem`、`## Proposal` 和下面的「Alternatives considered」。

### Alternatives considered：必须有

每篇 Note 都有 `## Alternatives considered`：每个真实考虑过的方案和它为什么没选，一个方案一段（开头加粗方案名），或者有争议的用 `### Why not <X>?` 小节。只记录真考虑过的，不编造。一个决策不写它赢了谁，就会被反复重新争论，而 Note 就是为了避免这个。

### 在生命周期之间挪

挪目录要同时改 `Status:` 行，并满足新目录的章节要求，否则校验不过。`proposed/` → `implemented/`：把 `## Proposal` 改写成现在时的 `## Decision`，把 `## Acceptance criteria` 和 `## Risks` 并进 `## Consequences`（或写成现在时的 `## Verification`），删掉计划，换成上线的样子。`proposed/` → `rejected/`：只在 `Status:` 行加理由，然后冻结。
