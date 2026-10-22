# 通知

要主人处理的事（Inbox）、哪些是刚来的、放久了没人管的（巡查），和它们经哪条路到主人那里：通话里由管家说，没在通话时农场手机响铃、系统通知、菜单栏。农场里画成手机的来电。

## 管什么，不管什么

| 管 | 不管 |
|---|---|
| Inbox：从核心状态现算要主人处理的事，每件带好各条路上说的话 | 一件事本身的状态：工单的站位（[工单](docs/subsystems/issue.md)）、帮工的阶段（[帮工](docs/subsystems/session.md)） |
| 哪些是刚来的：开机时已经在的不算，同一个 id 只算一次 | 电话本身：线路、Agora、念出来（[语音](docs/subsystems/voice.md)） |
| 巡查：放过了宽限期的，按频道交给管家 | 管家要不要提醒、怎么说（[管家](docs/subsystems/orchestrator.md)） |
| | 手机的响铃、未接和通话记录（[农场的皮](docs/subsystems/farm.md)）；连接器转到微信、飞书、QQ 的话（[田头](docs/subsystems/channel.md)） |

## 在哪

- 服务端 `apps/server/src/notice`（`Notices`，属于 Notifications 模块）：`notice.ts` 的 `news`（刚来的）、`overdue`（巡查的发现）、`patrol`（马上巡一次）、开机时的 `prime`；`rules.ts` 是巡查的纯规则（`patrolStep`、`patrolGrace`），黄金数据在 `testdata/rules.jsonl.gz`。
- Inbox 在 `apps/server/src/notice/inbox.ts`（`inbox`、`inboxEntries`，每件的话）；拼帧（`projection/frame.ts`）把它放在 `StateFrame.inbox`，和 `state`、`view` 并排。哪些是刚来的（`freshOf`）页面也要算，留在 `packages/protocol`。
- 页面：手机 `apps/web/src/farm/phone/calls.ts`，系统通知和菜单栏 `apps/web/src/app/Follow.tsx`、`apps/web/src/rules/notice.ts`。

## 模型和不变量

| 种类（`InboxKind`） | 什么时候 |
|---|---|
| `merge` | 帮工这一轮做完，等你看 |
| `ask` | 帮工有问题问你（交回来带着问题的也是这种） |
| `fix` | 帮工这一轮没做成 |
| `interrupted` | 这一轮停在了半路 |
| `conflict` | 合进主分支会冲突 |
| `quiet` | 干着活好久没动静 |
| `graph-draft`、`graph-ripe` | 种植计划拆好了等你看、做完了等你收 |
| `task-failed` | 计划里有一件没做成；重试又失败再算一次 |
| `mention` | @主人 的话，你没读、也没在那个对话里回 |
| `recurrence-ask` | 管家定的定时等你同意（目标是定时所在的频道） |

- 帮工的那件照它工单的站位算（和工单页、手机读的是同一个）；工单不在状态里的照帮工的阶段算，重试中的不算。种植计划里的帮工做完、没做成、冲突交给计划报，没动静照样算。
- 新的在前，同一时刻的保持收集的顺序；同一件事的 id 不变（帮工的是 `<id>:<种类>:<第几轮>`，@ 的是消息 id），下一轮又要主人是新的 id。
- **每件带好自己的话**：`who`（帮工的名字或「管家」）和 `words`：手机上的 `label`、系统通知的 `title` 和 `body`、菜单栏的 `tray`（@ 你的没有，算进未读）。通话里管家拿到的是 `title：body`。种类只在 `inbox.ts` 的一张表里配话，`Record<InboxKind, …>`，加一种不配话编不过；页面只读字段。
- 「回了」是主人在那个对话里在这条之后说过话；回了没读不算，读了没回也不算。主人的已读位置在 `Conversation.read`，存在服务端，几台设备看到的一样。
- **刚来的**（`freshOf`）：第一次看只记下，不算刚来；之后每个没见过的 id 算一次。服务端在开机的最后一段（帮工和工单都接回以后）`prime`，接回来的不算刚来；页面每次打开、农场画面每次回到前面各记一次。

## 怎么走

**刚来的**：`Notices` 订阅核心的事实，每次算一遍 Inbox，把刚来的发到 `news`。`voice` 订阅它：正在通话就把每件的 `title：body` 交给管家在电话里说（[语音](docs/subsystems/voice.md)「管家打电话找主人」）；没在通话就不管，手机会照帧里同样的 Inbox 响。

**巡查**：每 `patrol.heartbeat_minutes` 分钟（默认 10，0 关掉；开机后等一个间隔才第一次看）不调模型看一遍 Inbox（`patrolStep`）。放久了没人管的才报：`mention`、`ask` 15 分钟，`quiet` 20 分钟，`interrupted`、`task-failed` 30 分钟，`merge` 和 `conflict` 2 小时（`patrolGrace`，从 Inbox 给的时刻算，没有就从第一次看到算）；别的种类不报（没做成的当场就叫醒管家，`recurrence-ask` 是主人的事）。同一件事报过 4 小时内不再报，不再挂着的忘掉。有的才按频道发一条到 `overdue`；管家订阅它，写成「【巡查】#… 里有几件事放着没人管」叫醒自己，由它决定提不提醒主人。

**页面**：帧里的 `inbox` 有刚来的 → 农场画面开着、没在通话时手机弹出、响铃；窗口不在前面时发系统通知（`title`、`body`）；菜单栏每帧按 `tray` 列等你的事。

## 和谁打交道

- **核心状态（`core`）**：订阅事实、读状态；`frameOf` 把 Inbox 放进帧。
- **田头（`channel`）**：巡查的发现没有频道时归田头（`general()`）；@主人 的话从频道的消息里算。
- **管家（`orchestrator`）**：订阅 `overdue`，巡查的话由它写（`patrolText`）。它在本模块之上，所以是它来订阅，通知不调管家。
- **语音（`voice`）**：订阅 `news`，通话里说。
- **页面**：只读帧里的 `inbox`，不自己配话、不自己判断哪些要主人。

## 为什么这样

- **Inbox 是一条现算的规则，不存。** 来电和巡查的发现原来是两套大半重叠又各有出入的规则，改一处忘一处，手机响了巡查不报。放弃了像 Linear 那样存进库、带已读和归档：这些都能从核心状态现算，存一份就要保持一致。放在帧上不放在 `view` 里：`view` 是农场的画面，Inbox 是实际要你处理的事。
- **通话里说的和手机响的是同一批。** 原来通话里看的是工单站位的变化（另一条规则），手机看的是 Inbox，@主人、计划、定时只响不说。现在两条路都看 Inbox 里刚来的。
- **话跟着条目走，不在每条路上各配一份。** 原来同一种事的话写在五处（手机的标签、系统通知、菜单栏、通话、巡查），加一种要改五处。放弃了把配话的函数放进 protocol 让页面调：页面只该展示服务端给的结论。
- **送达的路不立端口。** 通话、手机、系统通知各自订阅、各自说，通知只决定什么、什么时候；为它们立一个「送达」接口，背后的适配器在两个进程里，换不来什么。

## 怎么验证

- `apps/server/src/core/golden.test.ts`（每种什么时候算、id、截字、先后，和工单站位一致）；`inbox.test.ts`（交回来带着问题、停在半路、每件的话、刚来的）。
- `apps/server/src/notice/rules.test.ts`：巡查照黄金数据。
- `apps/server/src/orchestrator/orchestrator.test.ts`「hears the patrol once」：巡查经 `overdue` 叫醒管家一次。
- `apps/server/src/voice/voice.test.ts`「tells what comes together once」：通话里两件刚来的合成一段说。
- 页面：`apps/web/test/farm-phone.spec.ts`（来电）、`src/farm/phone/calls.test.ts`、`src/rules/notice.test.ts`（菜单栏）。
