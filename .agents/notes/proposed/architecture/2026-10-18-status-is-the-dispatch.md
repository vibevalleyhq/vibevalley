# Agent Note: 改工单的状态就是派活

Status: proposed

## Problem

工单已经有 Linear 的六个状态（`protocol.IssueStatus`：backlog、todo、in_progress、in_review、done、canceled），但它们只能读：`protocol.IssueStatusOf` 从排队时间（`queued_at`）、关闭方式（`closed`）和最后一个帮工忙不忙推出来。要改状态，得调另外六个动作：

| 想要的 | 现在调 | 做的事 |
|---|---|---|
| 开工 | `issue.start` | 派给档案；没空地就排队（todo） |
| 不做了，放回去 | `issue.unqueue` | 从队里拿出来，回 backlog |
| 收下 | `issue.merge` | 合进主分支，关成 merged |
| 让它解冲突 | `issue.resolve` | 叫最新的帮工把主分支合进来 |
| 不要了 | `issue.cancel` | 叫帮工回家，关成 dismissed |
| 再来 | `issue.reopen` | 关了的工单带一句话重新开 |

动作和状态是两套说法：主人在看板上看到的是状态，要做的却是动作，得记哪个动作把工单挪到哪一列。命令行要走一个功能，也得先知道开工叫 start、收下叫 merge。Linear 和 Multica 里，把卡片拖到另一列就是全部操作。

## Proposal

**主人只改状态，改状态就是派活。** 六个动作收成一个接口 `issue.status`（`PUT /api/v1/issues/{id}/status`，`{"status": "todo", "text": "…"}`），命令行是 `vibevalley issue status <id> <状态>`。

### 状态分两种：主人定的和帮工做出来的

- **主人定的**：backlog、todo、done、canceled，表示主人想怎样。存在 `issue` 表的一个 `status` 列里，替掉现在的 `queued_at`；`closed` 留着，只记 done 和 canceled 是怎么关的（merged、dismissed……）。
- **帮工做出来的**：in_progress、in_review，表示活实际走到哪。照旧从帮工忙不忙推出来，不存。

读到的状态 = 有帮工的时候看帮工，没有的时候看主人定的。这样不会有两份互相打架的状态：帮工死了，工单就回到主人定的那一列，不会一直挂在 in_progress。

### 主人能挪到哪一列，挪了做什么

| 挪到 | 从 | 做的事 |
|---|---|---|
| todo | backlog | 派给档案：有空地马上开工（变 in_progress），没有就在 todo 等空地。没选档案的不能挪，说「先选帮工」 |
| todo | in_review | 再干一轮：`text` 是给帮工的话，和评论一样 |
| todo | done、canceled | 重开（现在的 reopen）。`text` 是给帮工的话 |
| backlog | todo | 不排了 |
| backlog | in_progress、in_review | 叫帮工停下，worktree 和分支留着，下次挪回 todo 接着干 |
| done | in_review | 收下：合进主分支（以后合并前先跑检查，没过就留在 in_review，输出交回帮工） |
| done | 别的 | 不合并，直接算完（没有改动的活、派给人的活） |
| canceled | 任何没关的 | 叫帮工回家，不合并（现在的 cancel） |

in_progress 和 in_review 主人不能挪进去：它们是帮工的事。解冲突（`issue.resolve`）不是一列，留成合并失败时的一个提示：合并因为冲突没成，工单留在 in_review，帮工收到「把主分支合进来再交」。

### 派给人

`assignee` 可以是主人自己（`owner`）。派给人的工单没有帮工，状态全是主人定的，挪到 todo 不派活，done 不合并。这是 Linear 本来的用法，农场里只是多一类不长庄稼的工单。

### 不归它管的

- **任务图里的工单**：状态跟着图和图里的任务走（`graph_action`、`task_action`），`issue.status` 拒绝。
- **派给管家的工单**：照旧交给管家，管家答完就关。

### 去掉的

不留兼容：`issue.start`、`issue.unqueue`、`issue.merge`、`issue.cancel`、`issue.reopen` 直接删，客户端、命令行和管家的工具（`tool` 里派活、收下、叫停的那几个）都改调 `issue.status`。`issue.resolve` 留到合并失败的提示里再定。

### 命令行走一个功能变成

```bash
vv issue create --json '{"title":"…","project":"vibevalley","assignee":"codex"}'
vv issue status <id> todo                  # 派活
vv issue get <id>                          # 轮询，到 in_review
vv issue status <id> todo --text "…"       # 不满意：再干一轮
vv issue status <id> done                  # 收下：合进 main
```

`issue run` 留着当便利写法：挪到 todo 再等它到 in_review。

## Alternatives considered

**状态整个存下来，帮工开工、交回时去改它。** 和 Linear 一样直白，读的时候不用推。但帮工的状态就有了两份（核心状态里一份，工单表里一份），农场重启、帮工半路死掉时都要对一遍，违背[核心状态只有一份](../../implemented/architecture/2026-10-11-farm-core-state.md)。

**保持动作，只在看板上拖卡片时翻译成动作。** 改动最小，但只有客户端受益；命令行和管家还得记六个动作，规则写在 Dart 里，也违背[客户端问服务端](../../implemented/architecture/2026-10-16-the-client-asks-the-server.md)。

**让 in_progress 也能挪进去（「马上开工」）。** 和 todo 只差没空地时怎么办；多一个入口，规则多一行，没换来什么。

## Acceptance criteria

- `issue.status` 的每一行转换在 `issue` 的测试里用 `oartest` 和真的 git 仓库测过；不许的转换（挪进 in_progress、任务图里的工单）被拒，并说为什么。
- 推状态的纯函数（`IssueStatusOf`）换成「帮工优先，否则主人定的」，黄金数据重写，`VIBEVALLEY_GOLDEN=update` 的 diff 只在 todo 和 backlog 的来源上。
- 命令行：照上面五条命令，codex 把一个小活做完合进 main。
- 客户端的看板把卡片拖到另一列就调 `issue.status`；工单详情里的开工、收下、叫停按钮都走它。`verify-app` 截图。
- 管家的样例（`verify-manager-evals`）照旧能派活、收下。改了工具描述，要真模型跑，先问主人。

## Risks

- 一个接口背了很多分支，`issue.status` 容易长成一个大 `switch`。转换表写成一张纯函数的表（从、到 → 做什么），测试照表一行一行测。
- 管家的工具描述要重写，模型可能一时不习惯「改状态」的说法，要跑一遍真模型。
- 派给人以后，看板上会出现没有帮工、也不会自己动的卡片，农场的皮要想好怎么画它们（不长庄稼的地）。
