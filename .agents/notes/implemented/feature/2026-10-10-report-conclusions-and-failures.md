# Agent Note: 汇报取「结论」，失败说人话

Status: implemented

## Problem

农场日志和仓库里的摘要取的是帮工这一轮最后说的话的结尾，常常抓到一句补充（「另外可选：……」），不是结论；失败时显示的是一串 JSON。主人得点开全文才知道做成没有、卡在哪。

## Decision

- 农场的规矩要求帮工把汇报的最后一段写成「结论：……」：一两句话说清做成了什么，或卡在哪、需要主人定什么，有提交就带 commit 号。摘要取这一段（只取这一段，后面的补充不算）；没写就退回取最后几段。
- 失败按 smith 的失败分类（`observe.FailureAdviceOf`）说人话（登录有问题、额度用完、限流、余额不够、模型用不了、上下文太长、服务商出错、进程退出……），加上怎么办（再试一次、过一阵再试、要你先处理）；要主人处理的另外发一条醒目的提醒。
- 管家转述时读汇报的开头（失败原因）和结尾（结论）。（后来帮工在田头上自己汇报，管家不再转述，见 [农场群聊](2026-10-11-farm-group-chat.md)。）

见 [server.md](../../../../docs/server.md)「帮工」。

## Alternatives considered

**让管家（大模型）给每份汇报写摘要。** 多一次模型调用，多花钱、多等；帮工自己最清楚结论。

**取第一段。** 帮工开头多半是在说「我先看看……」。

## Consequences

日志和仓库里一眼能看到结果，失败知道该谁处理。代价是依赖帮工照规矩写「结论：」；不照做时退回猜最后几段。

## Verification

`server/internal/runs/rules_test.go` 的 `TestCrewSummaryIsTheVerdict`、`TestCrewFailedTurnLeadsWithWhy`；`server/internal/farm/crew_test.go` 的 `TestCrewFailedTurnSaysWhy`（经过真的会话）。
