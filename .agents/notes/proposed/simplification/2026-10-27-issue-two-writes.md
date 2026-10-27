# Agent Note: 工单只有两个写操作：挪状态、说话

Status: proposed

## Problem

主人改一张工单的生命周期有三个入口，用三套词：

- `issue.status.update {status}`：挪到一列，服务端翻成内部的挪法（`Move`：start、round、reopen、complete……）。
- `issue.act {act}`：14 个按钮动词。九个只是转手：`start`、`complete`、`acknowledge`、`keep`、`close`、`reopen` 是挪状态，`tell`、`answer`、`resume` 是评论，`stop` 是停下一轮；`cure`、`resolve` 是服务端替主人写好话的评论；`reject` 记下意见再评论；`accept` 只有走它才能做。
- `issue.dispatch`（排着队的现在就试）、`issue.move`（看板里排顺序）各占一个接口。

结果是一个意图两三个入口（完成 = `status.update {done}` = `act complete` = `act acknowledge`），`act` 的输入是一袋可有可无的字段，打回没写意见、带话没写字要到服务端才拒；`move` 叫「挪」，文档里「挪」说的却是改状态。

验收又是一层：工单的验收方式 `review` 是「看一眼」（完成就算验收）或「要验收」（先 `accept` 才能完成），主人点两下才合得进去。

## Proposal

工单是一个深模块：接口只有两个写操作，规则全在里面。

1. **`issue.status.update {status, text?, agent?, edit?}`：工单该在哪儿。** 服务端照工单现在的处境决定这一次挪是什么：
   - 备选 → 待办：开工，没空位就排队（排队由服务端每隔一会儿自己试，不另设「现在就试」）。待办 → 备选：先别开工。
   - 等你看 → 待办，带话：又干一轮；在「等你验收」时这句话就是验收意见（`findingsOf` 读出每条，记进 `findings`，交给帮工），在「等回答」时就是回答。
   - 等你看 → 待办，不带话：只在卡住时能挪，话由服务端按卡住的原因写：没做成是接着修（`cure`），冲突是交代冲突（`resolve`），被打断是接着做（`resume`）。别的时候照旧要一句话。
   - 等你看 → 已完成：完成就是验收通过（清掉没解决的意见），照工单的交付走：`change` 合进主分支或开 PR，`branch` 留着分支、不合，`answer` 收下回答。没做成的一轮仍然不能完成。
   - 已完成、已取消 → 待办：带话重开；从没派出去的已取消 → 备选。
   - → 已取消：不做了。
2. **`issue.comment.create {text}`：对这张工单说话。** 有问题在等就是回答，帮工在干就是带话。

其余：

- 排序是 `issue.update` 的一个字段 `before`，不另设接口。
- 停下一轮是帮工的事，照旧 `session.stop`。
- 去掉 `issue.act`、`issue.previewAct`、`issue.dispatch`、`issue.move`；去掉验收方式 `review`（看一眼／要验收）和它在页面、工具上的开关；交付方式 `Deliverable` 加 `branch`，代替完成时的开关 `keepBranch`。
- 管家的 `accept` 工具留着：它照验收标准看过，过了记下 `reviewedAt`（农场上熟了的标记），没过就是带着意见又干一轮；它不挡主人完成。

**按钮是皮，服务端给出它发什么。** `IssueAttention.acts` 从一串动词改成一串 `IssueAction`：每个按钮的说法（`act`），和按下去做什么：挪到哪个状态（带不带话、话必不必填），对帮工说一句，或者停下这一轮。页面照它发，不自己判断；命令行的下一步（`nextSteps`）也从它来。动词里去掉 `accept`、`keep`。

## Alternatives considered

- **每个动词一个接口**（`issue.start`、`issue.accept`、`issue.reject`……）：十几个接口，每个都很薄，试跑翻倍；规则还是分在各处。
- **只留 `issue.act`，输入按动词分成联合类型**：类型查得住，但「挪状态」和「按钮」仍是两套词，看板拖动和按钮还是两条路。
- **验收和完成仍分两步**：只有「要验收」的工单多一步，主人点了「验收通过」还得再点「完成」；管家的验收仍然能记下，不需要挡住完成。

## Acceptance criteria

- 工单的写接口只有 `issue.create`、`issue.update`、`issue.delete`、`issue.status.update`、`issue.comment.create`、`issue.refine`（和它们的试跑）。
- 页面的每个按钮发的请求来自帧里的 `IssueAction`；看板拖动、按钮、命令行、管家的 `issue_status` 走同一张挪法表。
- 打回、接着修、交代冲突、接着做都是挪回待办；完成一张「要验收」的工单不用先点验收。
- 测试：挪法表（`moves.test.ts`）覆盖每种处境下的挪回待办和完成；`attentionOf` 的黄金数据换成 `IssueAction`；页面的打回、接着修、完成、留着分支收工照旧能点通。

## Risks

- 老的库作废：`issue.review` 一列去掉，`deliver` 多一个取值（照「内部不留兼容」）。
- 管家的提示和工具描述变了（`keep_branch`、`acceptance` 不在了），管家的评测要重跑（花钱，先问主人）。
