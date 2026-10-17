# Agent Note: 额度画成精力瓶，花费看得见，派活有上限

Status: implemented

## Problem

帮工跑在别人的账户上：有套餐的 runtime 有窗口额度，pi 按量付费从 DeepSeek 余额里扣。主人看不到还剩多少、花了多少；帮工可以一直派、一直花；DeepSeek 限并发，几个人改同一个项目也容易打架。

## Decision

见 [server.md](../../../../docs/reference/server.md)「额度、花费和上限」和 [farm-ui.md](../../../../docs/reference/farm-ui.md)「精力瓶」，要点：

- **额度**：有套餐的读 smith 的账户用量（runtime 的 `AccountUsage`，`server/internal/runtime/runtime.go`）；pi 读 DeepSeek 的余额（用 pi 自己的密钥调 `GET /user/balance`，只读）。画成游戏里的精力瓶和体力条，顶栏、帮工栏、地里、「农具」页都有。
- **花费**：从会话的 token 总数和 pi 价目表里这个模型的价格算，折成人民币（`cny_per_usd`，所以是估算）；每个帮工、每一轮、每天都看得到。
- **停**：DeepSeek 余额用完、或今天的花费到了每日预算（「农具」页里设），谁也派不出去，正在干的干完。这条检查是 protocol 的 `MoneyStop`，放在 `AgentIssues` 里（`server/internal/protocol/helpers.go`）；客户端的 `app/lib/rules/seeds.dart` 有它的 Dart 移植，提前在页面上显示。
- **上限**：农场 6 个；每台农机可以设最多同时干活几个（服务商限并发）；每个项目默认最多 3 个。派活和叫醒都要有空位，否则说清楚是哪个上限。

## Alternatives considered

**只显示服务商自己的账单。** 有延迟，按天汇总，看不出是哪个帮工、哪一轮花的。

**用余额的变化算每一轮的花费。** 几个帮工同时干活时分不开，余额也几分钟才读一次。

**超预算时叫停正在干的。** 会留下做了一半的改动；让它干完，只是不派新的。

**上限都写死。** 不同服务商的并发限制不一样，项目的大小也不一样，所以每台农机、每个项目各自可调。

## Consequences

主人随时知道还能干多少、花了多少，钱不会悄悄花完。代价是花费是估算（汇率和价目表可能和账单有出入）；额度读取要调各家的接口，停用的农机不读。

## Verification

`server/internal/workspace/work_test.go` 的 `TestCrewNobodySentWhenMoneyRunsOut`、`TestCrewLimitsOnProjectAndRuntime`；`server/internal/session/rules_test.go` 的 `TestCrewRoomOnTheFarm` 逐条测上限，`TestCrewSpendingCountedFromTheLastTotal` 测花费。
