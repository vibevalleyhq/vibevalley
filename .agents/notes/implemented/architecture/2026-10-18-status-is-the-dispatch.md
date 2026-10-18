# Agent Note: 改工单的状态就是派活

Status: implemented

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

## Decision

**主人只改状态，改状态就是派活。** 五个动作（start、unqueue、merge、cancel、reopen）收成一个接口 `issue.status`（`PUT /api/v1/issues/{id}/status`，`{"status": "todo", "text": "…"}`），命令行是 `vibevalley issue status <id> --json '{"status":"todo"}'`。转换是 `issue/status.go` 里的一张纯函数的表（`statusMove`），每张工单的 `moves` 由同一张表算出来。

### 状态分两种，不存两份

- **主人定的**：backlog、todo、done、canceled。不加新列：todo 就是 `queued_at`，done 和 canceled 就是 `closed`，这两列本来就记着主人的意思。
- **帮工做出来的**：in_progress、in_review，照旧从帮工忙不忙推出来（`protocol.IssueStatusOf` 没改）。

### 主人能挪到哪一列，挪了做什么

| 挪到 | 从 | 做的事 |
|---|---|---|
| todo | backlog | 派给档案：有空地马上开工，没有就在 todo 等空地。没选档案的被拒，说「还没选派哪个帮工档案」 |
| todo | in_review | 再干一轮：`text` 必填，和评论一样交给帮工 |
| todo | done、canceled（派过的） | 重开：同一个档案派一个新帮工，`text` 是给它的话 |
| backlog | todo | 不排了 |
| backlog | canceled（没派过的） | 挪回备选 |
| done | in_review | 收获：合进主分支，当场把工单关成 merged |
| canceled | in_progress、in_review | 叫帮工回家，当场关成 dismissed |
| canceled | backlog、todo | 没派过就不要了：出队，关成 dismissed |

in_progress 和 in_review 主人不能挪进去。派给管家的工单和种植计划里的工单 `moves` 是空的，`issue.status` 拒绝，说为什么。

收获和取消以后，帮工离开也会关上工单（`issues.left`），但那是异步的，中间一小会儿工单读起来像「已取消」。所以 `issue.status` 当场把关法写上，答复里的状态已经是关上的。

### 客户端问服务端

看板原来在 `rules/issues.dart` 里自己写了「哪列能拖到哪列」（`moveOf` 带 `split`），现在只看 `Issue.moves`：拖到处理中要 `moves` 里有 todo（开工或重开），拖到已关要有 done 或 canceled（打开收获和收工的框）。卡片上和地块上的收获、收工、开工、不排了、重开都调 `issue.status`。

### 命令行走一个功能

```bash
vv issue create --json '{"title":"…","project":"vibevalley","assignee":"codex"}'
vv issue run <id>                                          # 挪到 todo，等到 in_review，打出改动
vv issue status <id> --json '{"status":"todo","text":"…"}' # 不满意：再干一轮
vv issue status <id> --json '{"status":"done"}'            # 收下：合进 main
```

`issue run` 只在工单还在备选时挪一下，派过的只等。

### 先没做的

- **派给人**（`assignee` 是主人）：第一版不做，只做派给帮工这条路。
- **管家的工具**：派活、收获、叫停这些工具说的是能力，不是看板的列，照旧调服务里的方法，描述没改，不用重跑管家的样例。
- **解冲突**（`issue.resolve`）：不是一列，留着原来的接口。

## Alternatives considered

**状态整个存下来，帮工开工、交回时去改它。** 和 Linear 一样直白，读的时候不用推。但帮工的状态就有了两份（核心状态里一份，工单表里一份），农场重启、帮工半路死掉时都要对一遍，违背[核心状态只有一份](../../implemented/architecture/2026-10-11-farm-core-state.md)。

**保持动作，只在看板上拖卡片时翻译成动作。** 改动最小，但只有客户端受益；命令行和管家还得记六个动作，规则写在 Dart 里，也违背[客户端问服务端](../../implemented/architecture/2026-10-16-the-client-asks-the-server.md)。

**让 in_progress 也能挪进去（「马上开工」）。** 和 todo 只差没空地时怎么办；多一个入口，规则多一行，没换来什么。

## Verification

- 表：`issue/status_test.go` 的 `TestStatusMoves` 照表测每个状态（派过和没派过）能挪到哪，管家的和计划里的工单什么都挪不了，每个拒绝都有原因。
- 整条路：`workspace/work_test.go` 的 `TestMovingAnIssueIsTheWork` 用 `oartest` 和真的 git 仓库，备选挪到待办开工、交回来、没话不让再干一轮、带话再干一轮、挪到已完成合进 main（两轮的提交都在），没派过的取消再挪回备选。
- 接口和命令行：`handler` 的测试走 HTTP 挪状态；`cmd/vibevalley` 的 `TestIssueRunWaitsForTheReview` 测 `issue run` 先挪到待办再等。
- 客户端：看板拖卡、地块上的收获和铲子、工单详情的按钮都改调 `issue.status`，`bun run flutter:check` 全过；`moveOf` 的测试按 `moves` 测。
- 真的服务端：`verify-server` 上建一张没选档案的工单，挪到待办被拒；挪到已取消关上，再挪回备选。

## Consequences

- 看板能不能拖、地块能不能收，都由服务端的 `moves` 说了算；以后加一种转换只改 `statusMove` 一处，客户端不用跟着改规则。
- 命令行的循环只剩三个动词：`issue create`、`issue run`、`issue status`。
- 派给人还没做：要做时 `statusMove` 加一个「没有帮工」的分支，看板上会多出不长庄稼的卡片，农场的皮要想好怎么画。
