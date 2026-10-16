# Agent Note: 接回 claude 和 codex

Status: implemented

## Problem

所有帮工都跑在 pi 上（[pi-only-for-now](../simplification/2026-10-10-pi-only-for-now.md)），用的是 DeepSeek V4.1 Flash。主人另有 Claude Code 和 codex 的订阅额度，难的活想交给它们；一张种植计划里，也想让不同的步骤由不同的农机来做。oar 一直驱动得了这两台，但 VibeValley 没在真实项目里用它们跑通过。

## Decision

claude 和 codex 跟 pi 并列使用：

- **种子档案**：新加两个。Claude 师傅（claude，读大代码库、重构、查难缠的 bug）、Codex 老匠（codex，照工单把功能做出来，改到测试通过）。模型和思考强度不填，跟着农机自己的默认值走。已有的配置不会自动多出它们，要在「农具」页启用，再捏一个；主人现在的配置里已经加上了。
- **额度用完就不派**：这两台按套餐计费，不按钱。`MoneyStop`（protocol 的 `helpers.go`）原来只看余额和每日预算，现在多看一条：任何一个用量窗口到了 100%，就不再派人，并写明哪天几点重置。否则派出去也只会以「额度用完」失败。
- **花费只记 token**：pi 的价目表里没有它们，所以不折成人民币，也没有每日预算。
- **汇报晚一拍**：claude 只在一轮结束的那一帧里报用量，排在 `turn_ended` 后面，而 smith 收到 `turn_ended` 就当场发出汇报。crew 等这一轮的事件都读完（`server/internal/runs/crew.go` 的 `reports`；TypeScript 服务端时是等下一个宏任务）再施加汇报，所以汇报带得上这一轮的花费。种植计划合并一步时用的花费也来自这里。

其余都是本来就按 runtime 通用的代码，这次在真实项目里跑通了：会话、人设和技能、工具的分类、失败的分类、插话、worktree 里提交、收获。各农机的差别见 [agents-and-runtimes.md](../../../../docs/agents-and-runtimes.md)「在用的农机」。

## Alternatives considered

**把现有的种子档案改回 claude、codex**（比如把后端老周改到 claude）。主人现有的帮工会悄悄换了脑子，花费和额度也跟着换了账户。新加档案不动已有的。

**按 Anthropic 和 OpenAI 的 API 价格估算它们的花费。** 订阅不按 token 收钱，折出来的人民币是假的，还会触发每日预算。额度窗口才是真实的限制。

**额度用完时照派，让失败分类告诉主人。** 每派一次就白开一个会话，地上还多一块「有虫」。派之前就能知道，就不派。

**把汇报改成等 oar 的会话空闲以后再施加。** 要依赖 oar 内部的状态时序；等一个宏任务就足够让同一帧里的事件落地，也不改 oar。

## Consequences

主人可以把难的活点名交给 Claude 师傅或 Codex 老匠，一张种植计划里也可以混用三台农机。代价有三条：

- claude 和 codex 的花费只有 token，仓库里看不出钱；
- 订阅窗口在别处（主人自己用 Claude Code、codex 时）也会消耗，帮工可能因此派不出去；
- 汇报要等这一轮的事件读完才施加，晚一点点，对页面没有可见的影响。

## Verification

- `server/internal/farm/crew_test.go` 的 `TestCrewNobodySentWhenMoneyRunsOut`：窗口到 100% 时拒绝并写明重置时间，99% 照常派。
- 2026-10-11 在真实项目 `rt-smoke` 里跑通：
  - 一张种植计划由 Claude 师傅来拆，结果 4 步，Codex 老匠写实现，pi 上的两个帮工写测试和 README，Claude 师傅做整体验证，3 分钟合完，收获后 42 个测试全过；
  - 另有一张普通工单交给 Claude 师傅，汇报带上了这一轮的 token，收获进主分支。
- 用量报得晚的问题，当时脚本扮演的 runtime 模拟不出来（它不报用量），这一条只在真实的 claude 上验证过。smith 的 `oartest` 现在会在一轮结束的同一帧里报用量，但还没有测试查汇报带上了这一轮的花费。
