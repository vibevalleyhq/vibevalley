# 定时

定时（`Recurrence`）是一张工单的一种触发：到点在频道里说一声，再开这张工单的一次干活（run），派给帮工档案或管家。「每天早上九点在 #clock-in 跑一遍测试」是一个定时；它从头到尾只有一张工单，每次到点是这张工单的一次干活。定时是农场的，存在农场的表里，主人在页面上看得到、关得掉；管家只是用工具定它。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 定时的模型、五种时间写法、时区、下次什么时候 | 到点以后工单怎么派、重开、带话（[工单](docs/subsystems/issue.md)，`issue/issue.ts` 的 `scheduled`） |
| 谁定的、要不要等主人同意 | 管家怎么接住到点的那句话、答完等主人点头（`manager`，[管家](docs/subsystems/manager.md)） |
| 每隔一阵看一遍、到点先存再说再发布、错过的补一次 | 巡查：不调模型地看 Inbox、有事叫醒管家（`manager/manager.ts`，[管家](docs/subsystems/manager.md)） |
| 定时在核心状态里的一份（`WorkspaceState.Recurrences`） | 频道、频道的默认项目、提示怎么投递（[田头](docs/subsystems/channel.md)） |
| | VibeValley 自己的 agent 自带的定时（`agent/brain/recurrences.ts` 的 `recurrences.json`）：当管家时关掉（`recurrences: false`） |

## 在哪

- 服务端 `apps/server/src/recurrence`（`Recurrences`）：`recurrence.ts` 存取、开机读表、每次检查（`tick`）和到点发布（`due`，一条流）；`rules.ts` 是只有它用的纯函数：`dueRecurrences`、`isMissed`、`afterRun`、`needsOK`。
- 几处都用的规则在 `apps/server/src/recurrence/when.ts`：`nextRun`、`recurrenceProblem`、`whenText`、`nextText`、`dueText`，五段 cron 的解析、下次时间、说成话；下次时间用 Effect 的 `Cron.make`、`Cron.next` 和时区，解析和报错是自己的。
- 表：`recurrence`（一个定时一行，时间写法存成 JSON 的 `spec`）；工单表的 `recurrence` 列指着它的定时。
- 接口：`recurrence.create`、`recurrence.list`、`recurrence.update`、`recurrence.delete`（[capabilities.md](docs/reference/capabilities.md)）；`recurrence.update` 只有主人和「连接到本机」能调，管家不能。管家的工具 `recurrence`、`list_recurrences`、`cancel_recurrence` 在 `tool/tool.ts`。
- 配置：`recurrence.tick_ms`，默认 20000（20 秒看一遍；0 或更小是每毫秒）。
- 页面：频道菜单的「定时」（`apps/web/src/farm/chat/ChannelMenu.tsx`）和聊天页的「定时」标签（`apps/web/src/pages/chat/Tabs.tsx`）列出这个频道的定时，能开关、删、对待批的点「同意」「不要」；看板上定时的工单带「定时」标签（`apps/web/src/rules/cards.ts`）。

## 模型和不变量

- **五种时间**（`RecurrenceWhen`，封闭的联合）：`once`（一个时刻）、`every`（每隔几分钟，至少 `minEveryMinutes` = 1）、`daily`（每天 `HH:MM`）、`weekly`（每周几、`HH:MM`，0 是周日）、`cron`（五段：分 时 日 月 周几）。每个定时带时区：IANA 名字或偏移（`+08:00`、`+0800`、`+08`），没给就用这台电脑的（`$TZ`，再看 `/etc/localtime` 指向哪，再用当前偏移）。
- **cron 的读法**：每段是逗号隔开的 `*`、`n`、`a-b`，都能带 `/步长`；周几 0 到 7，0 和 7 都是周日；两个日子段都不以 `*` 开头时照 Vixie cron，哪个对上都算，否则两个都要对上。八年（`cronYears`）里都不会到点的（2 月 30 号）不收；`recurrenceProblem` 说清是哪一段写错了。`whenText` 把常见的说成话（每天、工作日、周末、每周几、每月几号、每小时第几分），其余显示 `cron 0 9 1 1 *`。
- **下次什么时候不存**，`nextRun` 从上次跑的时间（没跑过就从定好的时间）算：严格晚于它的第一个对上的分钟。`daily`、`weekly`、`cron` 沿着墙上的钟走：调钟跳过的时刻算成调钟前的同一时刻往后挪（春天拨快那晚的 02:30 是 03:30），重复的取第一次；所以写成 cron 的每天、每周和 `daily`、`weekly` 在同样的时刻到点。关着的定时没有下次。
- **谁定的**（`Recurrence.by`）：`owner` 是主人经接口、命令行定的，`manager` 是管家用 `recurrence` 定的；列表里管家定的写着「管家定的」。
- **等主人同意**（`needsOK`）：主人定的、管家在主人这一轮里（最新那条输入有主人的话）定的，当场生效。管家不是主人叫醒时定的，只有不派帮工的一次性回头看当场生效；会反复来的、直接派帮工的存成关着、`pending`，到点也不跑，在 Inbox 里是一条 `recurrence-ask`。主人点「同意」是 `recurrence.update` 打开，同时清掉 `pending`；点「不要」是 `recurrence.delete`。管家的工具对待批的回「定好了，等主人同意才生效：……」，它照实告诉主人。
- **派给谁**：写了帮工档案（按 id，再按名字找）的派给那个档案，这时要写项目或频道有默认项目，否则不收；没写的派给管家（工单的 `assignee` 是 `manager`）。管家用的工具里不填频道就是它正在回话的频道，接口里不填是田头。
- **一个定时一张工单**：`Issues.ofRecurrence` 取指着这个定时的最近一张；每次到点是它的一次干活，触发是 `RunTrigger` 的 `recurrence`（带着哪个定时、是不是补跑）。
- **定时有一份**：表是家，开机读进核心状态（`recurrence` 事实），每次改先写表再施加事实，删掉施加 `recurrenceGone`；`spec` 读不了的那行不进核心状态。增、改、删和每次检查由一把锁排成一个一个来。

## 怎么走

**定**：

1. `recurrenceProblem` 先查：要有名字、要写到点做什么、时区认得、一次性的在以后、间隔至少 1 分钟、`HH:MM` 写对、每周的天在 0–6、cron 每段写对。
2. 找频道和档案；直接派帮工的没有项目就拒绝。
3. 按 `needsOK` 定开着还是待批，写表，施加事实。管家定好后工具回给它 `whenText` 的那句话和下次时间，它能自己对一遍。

**到点**（`tick`，开机后所有服务就绪时先跑一次，之后每 `recurrence.tick_ms` 一次）：

1. `dueRecurrences` 挑出下次时间不晚于现在的。错过了好几次的也只算一次。
2. 晚了超过 5 分钟（`missedAfterMs`）的算补跑：服务端没开着时错过的，开机后只补一次，提示里写「（服务端没开着时错过的，补一次）」；循环的从现在往后排，中间错过的不一个个补。
3. 先存这次运行的时间（`afterRun`：记下 `last_run`，一次性的同时关掉）。**保存失败就不发提示、不派活**，下一次检查再试。
4. 施加新的定时，在频道里说一条 `dueText`：「⏰ 定时「…」到点了：…」。
5. 发布 `Due{Recurrence, Missed}`。工单服务接住（`scheduled`）：
   - 第一次到点：写这张工单（标题是定时的名字，说明是要做的，项目是定时的或频道默认的）并开工，地满了就排队；排队时触发和是不是补跑一起写进 `issue_queue`。
   - 派给帮工的：工单还在备选、待办就开工；关了（收获、收工）就重开、派一个新帮工；帮工还在就把 `dueText` 带给它。
   - 派给管家的：关着就重开，交给管家；管家收到「【定时任务「…」到点了】」开头的一句，照着做，回答发在这个频道，这一轮结束时工单进「等你看」，主人点「知道了」才关成 `answered`（[工单](docs/subsystems/issue.md)）。重启时还在答的管家工单关成 `lost`。
   - 写不了工单或开不了工，在频道里说「定时「…」写不了工单／开不了工：…」。

**开关**：关掉只改 `enabled`；重新打开一个周期定时，开关和起算时间（`last_run` 记成现在）一次写入，从现在往后算，不补关着时错过的。一次性的跑过就关，列表里显示「做过了」，主人可以删。

**列表里的「下次」**（`nextText`）：下次的时刻；开着却不会再到点的是「不会再到点」；待批的是「等主人同意」；跑过的一次性是「做过了」；其余「关着」。

## 和谁打交道

- **工单（`issue`）**：订阅 `Due()`，一个定时一张工单，到点开它的一次干活；派活、排队、重开、带话都照工单的规则（[工单](docs/subsystems/issue.md)）。
- **田头（`channel`）**：定时属于一个频道（`recurrence.channel_id`）；到点的提示和出错的提示都经 `notice` 说在这个频道里。
- **帮工档案（`agent`）**：定时只认存在的档案；`manager` 这个 id 没有档案能用。
- **管家（`manager`、`tool`）**：用 `recurrence`、`list_recurrences`、`cancel_recurrence` 定、看、删，调不了 `recurrence.update`。系统提示里写着：主人说「每天」「到点」时定；派了活、答应了主人一件事、在等一个结果时，可以自己定一次性的回头看；会反复来的只在主人要的时候定。管家自己的定时（没写档案的）快到点时，它闲着也不压缩（`wakeSoon`）。
- **Inbox（`apps/server/src/notice/inbox.ts`）**：待批的定时是一条 `recurrence-ask`，主人同意或删掉它就没了。

## 为什么这样

- **定时是一张工单的触发，一个定时一张工单。** 放弃了每次到点写一张新工单：一个「每 5 分钟」的定时一天写 288 张，看不出一个定时干过几次，也和「工单、带话都触发一次干活」的模型对不上。放弃了没写档案的定时直接对管家说一句话：两个出口靠两个订阅者各自看「有没有写档案」分工，交给管家的那一半不进看板、没有干活的记录。
- **管家的工单答完等主人点头，点了关成 `answered`。** 没用已有的 `dismissed`：收工是主人请帮工走，意思不一样，看板和统计会混在一起。答完不再自动关：一轮没崩不等于答上了（[工单](docs/subsystems/issue.md)「已完成只由主人点头」）。
- **到点先在频道里说一声，再派活。** 主人在频道里看得到每次定时做了什么；写了档案的不经过管家，不花管家的一轮。这一点和 Raft 的提醒不同：Raft 到点只叫醒建它的 agent，频道里什么也不发，也只有 agent 能建。
- **定时是农场的，不是 agent 的。** 存在农场的表里，页面能看、能关；VibeValley 自己的 agent 当管家时关掉它自带的定时，不留两份。
- **下次什么时候不存。** 从上次跑的时间算，打开、重启都不用改它；错过的只补一次，不一个个补。
- **到点先保存，再说再发布。** 保存失败还发出去，重启后会再跑一次；先存，最坏是这一次晚一个检查周期。
- **cron 自己写，不用 `robfig/cron`。** 多一个依赖，它的调钟规则和已有的四种不一样，同一个时间写成 cron 和写成每天会在不同时刻到点。五段的解析不到一百行，和每天、每周共用 `recurrenceWallTime`。
- **四种固定写法和 cron 并存。** 只留 cron，管家写「每天九点」时更容易写错；加更多固定种类（工作日、每月），每多一种说法多一种形状，还是有说不出的。工具说明里写明 cron 只用在前四种说不清的时候。
- **管家没被主人叫醒时定的会反复来、会派帮工的定时要主人同意。** 这两种会在主人不看着时持续花钱；管家给自己定的一次性回头看不派帮工，当场生效（[分清话是谁说的](docs/subsystems/manager.md)第 5 节）。
- **醒了就说，不分后台和前台。** 放弃了「醒了先不说，要说再调工具」：能少吵，但多一套规则（哪些叫醒算后台、谁判断该不该说）。

## 还没做的

- 到点的定时交给帮工时直接 `session.Deliver`，绕开频道的投递和节奏；改成往 agent 的信箱投一封：[一个 agent 一个信箱](.agents/notes/proposed/architecture/2026-10-18-one-mailbox-per-agent.md)。

## 怎么验证

- `apps/server/src/recurrence/recurrence.test.ts`：黄金数据（`testdata/rules.jsonl.gz`）；错过几次只算一次、补跑、一次性跑过就关；什么要等主人同意；定、到点、说出来、存下、重开后接着；存不下的一次不发布、下次再试；cron 的定时存下、坏的拒绝；管家自己定的等主人同意，重启后也等。服务的时钟由测试换（`RecurrenceOptions.now`）。
- `apps/server/src/recurrence/cron.test.ts`：每天、每周、每隔、一次的下次时间，cron 的下次时间（两个日子字段任一到点、闰年）和夏令时前后与每天、每周一致，报错，说成话；折法留着定时、帧里填话。
- 页面：`apps/web/test/chat.spec.ts`（定时的开关和删）。
