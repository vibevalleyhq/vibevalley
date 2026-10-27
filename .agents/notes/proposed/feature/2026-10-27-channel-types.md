# Agent Note: channel 照 Discord 分成频道、私聊和串，接口按单数资源排

Status: proposed

## Problem

说话的地方已经只有一个概念：`Channel`（[田头](docs/subsystems/channel.md)）。但它的 `type` 仍按「是不是田头」分：`general`、`channel`、`thread`。

- **默认频道被写死成了「田头」。** 「田头」是农场那张皮对群聊的叫法，代码里却是一种类型（`type: "general"`）、一个常量名字（`generalName`，地址 `#田头` 写进了给模型的提示），发消息不写 channel 就算它（`SayRequest.channel` 可空），页面再把它翻回 `undefined`。它其实只是农场默认的那个频道：能说的话、谁收到、怎么读，和别的频道一样。
- **没有私聊。** 主人想单独和管家说一句，只能在田头说：在场的帮工都收到（不叫醒，但进了它们的未读和摘要），田头也被刷满。微信本来就是一对一的，连接器却只能接到一个频道上。
- **接口表没有一套规矩。** 路径用复数（`/channels`、`/issues`），库表却是单数；发消息是根上的一个动词 `POST /api/v1/say`，别的都是资源在前；已读是设一个位置，却用 `POST`；`POST /api/v1/orchestrator/hear` 是「当前那一通电话里听到的一句」，挂在管家下面；同样是读一个、存一个，有的叫 `load`/`save`，有的叫 `get`/`update`。

## Proposal

### 1. 三种 channel，照 Discord 的 type

| `type` | 是什么 | Discord |
|---|---|---|
| `channel` | 频道：有名字、说明、默认项目，在场的帮工都在里面 | `GUILD_TEXT` |
| `direct` | 私聊：主人和一个 agent，`peer` 是对面那个参与者；这一版只有管家 | `DM` |
| `thread` | 串：挂在 `parent` 频道的一条消息 `root` 下（工单串、计划串、没挂工单的帮工的 `talk` 串、在 `#频道:<号>` 下现开的） | `PUBLIC_THREAD` |

- **有一个默认频道，它是数据，不是类型也不是名字。** 库里 `channel.is_default`（唯一的那一行为真），协议里 `Chat.default` 是它的 id（像 Discord 服务器的 `system_channel_id`）；`PUT /api/v1/channel/{id}/default` 换一个。开机时一个频道都没有，就建一个普通频道 `general` 设成默认（频道名存下来、写进地址，不随语言变）。代码里认它只看这个 id：`generalOf` 改成 `defaultOf`，`generalName` 不在了；给模型的提示写默认频道的实际名字。农场把默认频道画成「田头」，那是农场词表里的一个说法。
- **私聊在开机时建好**（和管家的那一个，`peer` 是 `orchestrator`）；一个 `peer` 只有一个私聊（唯一索引）。没有名字，列表里用对面的名字。以后加和帮工的私聊、语音频道（`voice`）时只是多一种 `peer` 或 `type`。
- **帮工的 `talk` 串仍是串**：它挂在派活那条消息下面，带着派的是什么活，不是私聊。

### 2. 私聊里谁收到

两个人的地方，不用 @：主人说的每一句交给 `peer`，叫醒它（新的理由 `direct`）；`peer` 说的给主人（进未读）。@ 别人在私聊里只是字，不投递：别人不在这里。三道刹车照旧，只管 agent 叫醒 agent。管家在哪里被叫就回在哪里，所以它在私聊里答。

### 3. 接口表

规矩，写进 `docs/subsystems/core.md`「接口」，能查的写成 `packages/protocol` 的测试：

- **路径用单数**，和库表一样：`/api/v1/<模块>[/{id}][/<子资源或动作>]`，第一段是 op 所属的模块（测试查：`channel.*` 在 `/api/v1/channel` 下）。
- **op 的动词**：增删改查是 `list`、`get`、`create`、`update`、`delete`；读一个子资源用它的名字（`issue.runs`、`channel.messages`）；不是增删改查的命令用领域里的动词，挂在资源下面（`issue.dispatch`、`issue.act`）；试一下会怎样是 `preview<动作>`，路径 `…/<动作>/preview`。
- **方法**：读用 GET；建一个、发一个命令用 POST；设一个值、改一个已有的用 PUT；删用 DELETE。

下表的「原来」只写除了复数改单数以外变了的地方。三条 SSE（`/state`、`/live`、`/events`）不在表里：它们要并进页面的那条 WebSocket，那一步再说。

| 方法 | 路径（`/api/v1` 下） | op | 原来 |
|---|---|---|---|
| **channel** | | | |
| POST | `/channel/{id}/message` | `channel.send` | `POST /say`，`channel.say` |
| POST | `/channel` | `channel.create` |  |
| PUT | `/channel/{id}` | `channel.update` |  |
| GET | `/channel/{id}/message` | `channel.messages` | `channel.history` |
| PUT | `/channel/{id}/read` | `channel.read` | `POST /channels/{id}/read`，`channel.markRead` |
| PUT | `/channel/{id}/default` | `channel.makeDefault` | 新加：设成默认频道 |
| **issue** | | | |
| POST | `/issue/{id}/comment` | `issue.comment` |  |
| GET | `/issue/{id}/changes` | `issue.changes` |  |
| GET | `/issue/history` | `issue.history` |  |
| GET | `/issue` | `issue.list` |  |
| GET | `/issue/{id}` | `issue.get` |  |
| GET | `/issue/{id}/run` | `issue.runs` |  |
| GET | `/issue/{id}/timeline` | `issue.timeline` |  |
| POST | `/issue` | `issue.create` |  |
| PUT | `/issue/{id}` | `issue.update` |  |
| DELETE | `/issue/{id}` | `issue.delete` |  |
| POST | `/issue/{id}/delete/preview` | `issue.previewDelete` |  |
| PUT | `/issue/{id}/move` | `issue.move` |  |
| PUT | `/issue/{id}/status` | `issue.status` |  |
| POST | `/issue/{id}/status/preview` | `issue.previewStatus` |  |
| POST | `/issue/{id}/refine` | `issue.refine` |  |
| POST | `/issue/{id}/dispatch` | `issue.dispatch` |  |
| POST | `/issue/{id}/act` | `issue.act` |  |
| POST | `/issue/{id}/act/preview` | `issue.previewAct` |  |
| **graph** | | | |
| POST | `/graph` | `graph.split` |  |
| PUT | `/graph/{id}/task/{task}` | `graph.updateTask` |  |
| DELETE | `/graph/{id}/task/{task}` | `graph.deleteTask` |  |
| POST | `/graph/{id}/task/{task}/delete/preview` | `graph.previewDeleteTask` |  |
| POST | `/graph/{id}/act` | `graph.act` |  |
| POST | `/graph/{id}/task/{task}/act` | `graph.taskAct` |  |
| GET | `/graph/{id}/changes` | `graph.changes` |  |
| GET | `/graph/{id}/event` | `graph.events` |  |
| **session** | | | |
| POST | `/session/{id}/stop` | `session.stop` |  |
| GET | `/session` | `session.list` |  |
| GET | `/session/{id}` | `session.get` |  |
| GET | `/session/{id}/event` | `session.events` |  |
| **agent** | | | |
| GET | `/agent` | `agent.list` |  |
| POST | `/agent/check` | `agent.check` |  |
| POST | `/agent` | `agent.create` |  |
| PUT | `/agent/{id}` | `agent.update` | `agent.save` |
| DELETE | `/agent/{id}` | `agent.delete` |  |
| POST | `/agent/{id}/delete/preview` | `agent.previewDelete` |  |
| **memory** | | | |
| GET | `/memory/{agent}` | `memory.list` |  |
| GET | `/memory/{agent}/recall` | `memory.recall` |  |
| POST | `/memory/{agent}` | `memory.create` |  |
| DELETE | `/memory/{agent}/{memory}` | `memory.delete` |  |
| POST | `/memory/{agent}/{memory}/delete/preview` | `memory.previewDelete` |  |
| **orchestrator** | | | |
| POST | `/orchestrator/open` | `orchestrator.open` |  |
| POST | `/orchestrator/stop` | `orchestrator.stop` |  |
| GET | `/orchestrator/archive` | `orchestrator.listArchive` |  |
| GET | `/orchestrator/archive/{name}` | `orchestrator.getArchive` |  |
| POST | `/orchestrator/eval` | `orchestrator.markWrong` |  |
| **skill** | | | |
| GET | `/skill` | `skill.list` |  |
| POST | `/skill` | `skill.create` |  |
| PUT | `/skill/{id}` | `skill.update` | `skill.save` |
| DELETE | `/skill/{id}` | `skill.delete` |  |
| POST | `/skill/{id}/delete/preview` | `skill.previewDelete` |  |
| **runtime** | | | |
| GET | `/runtime` | `runtime.list` |  |
| POST | `/runtime/{id}/refresh` | `runtime.refresh` |  |
| PUT | `/runtime/{id}/setting` | `runtime.update` |  |
| **project** | | | |
| GET | `/project` | `project.list` |  |
| POST | `/project/check` | `project.check` |  |
| POST | `/project` | `project.create` |  |
| GET | `/project/{id}/language` | `project.languages` |  |
| GET | `/project/{id}/template` | `project.templates` |  |
| GET | `/project/{id}/activity` | `project.activity` |  |
| **recurrence** | | | |
| POST | `/recurrence` | `recurrence.create` |  |
| GET | `/recurrence` | `recurrence.list` |  |
| PUT | `/recurrence/{id}` | `recurrence.update` |  |
| DELETE | `/recurrence/{id}` | `recurrence.delete` |  |
| POST | `/recurrence/{id}/delete/preview` | `recurrence.previewDelete` |  |
| **doc** | | | |
| GET | `/doc` | `doc.list` |  |
| POST | `/doc` | `doc.create` |  |
| POST | `/doc/import` | `doc.import` |  |
| GET | `/doc/{id}` | `doc.get` |  |
| POST | `/doc/{id}/submit` | `doc.submit` |  |
| GET | `/doc/{id}/markdown` | `doc.markdown` |  |
| POST | `/doc/{id}/demo` | `doc.demo` |  |
| **voice** | | | |
| POST | `/voice/heard` | `voice.hearCurrent` | `POST /orchestrator/hear`，`orchestrator.hear` |
| POST | `/voice/session` | `voice.session` |  |
| POST | `/voice/renew` | `voice.renew` |  |
| POST | `/voice/agent` | `voice.start` |  |
| POST | `/voice/agent/stop` | `voice.stop` |  |
| POST | `/voice/agent/heard` | `voice.heard` |  |
| POST | `/voice/agent/said` | `voice.said` |  |
| POST | `/voice/dictate` | `voice.dictate` |  |
| **connector** | | | |
| GET | `/connector` | `connector.list` |  |
| POST | `/connector/{id}/login` | `connector.login` |  |
| POST | `/connector/{id}/verify` | `connector.verify` |  |
| POST | `/connector/{id}/logout` | `connector.logout` |  |
| PUT | `/connector/{id}/channel` | `connector.channel` |  |
| **lan** | | | |
| GET | `/lan` | `lan.get` | `lan.status` |
| PUT | `/lan` | `lan.update` |  |
| POST | `/lan/pairing` | `lan.startPairing` |  |
| DELETE | `/lan/pairing` | `lan.stopPairing` |  |
| POST | `/lan/pairing/delete/preview` | `lan.previewStopPairing` | `POST /lan/pairing/stop/preview` |
| POST | `/lan/pairing/answer` | `lan.answerPairing` |  |
| DELETE | `/lan/device/{id}` | `lan.deleteDevice` |  |
| POST | `/lan/device/{id}/delete/preview` | `lan.previewDeleteDevice` |  |
| POST | `/lan/pair` | `lan.pair` |  |
| GET | `/lan/me` | `lan.me` |  |
| **setting** | | | |
| GET | `/setting` | `setting.get` | `setting.load` |
| POST | `/setting/check` | `setting.check` |  |
| PUT | `/setting` | `setting.update` | `setting.save` |
| **github** | | | |
| GET | `/github` | `github.get` | `github.status` |
| POST | `/github/refresh` | `github.refresh` |  |
| **game** | | | |
| GET | `/game/achievement` | `game.achievements` |  |
| PUT | `/game/title` | `game.chooseTitle` | `POST /game/title` |
| **server** | | | |
| GET | `/server/health` | `server.health` | `GET /health` |

### 4. 页面

聊天页的侧栏和农场的频道菜单分两段：频道（田头在最前）、私聊（对面的名字和脸）。打开私聊和打开频道一样（`/chat/<id>`），输入框不用 @。

## Alternatives considered

- **默认频道留作一种类型或认它的名字**：要一直在每个分支里多写一种，名字一改就认不出；它和别的频道只差「默认」这一点，是一条数据。
- **路径用复数**（REST 的常见写法）：库表、模块、op 都是单数，路径跟着单数，一个概念只有一种写法。
- **把帮工的 `talk` 串改成和帮工的私聊**：帮工是一次派活（Session），活完了就走；它的串挂在派活消息下面，读得出派的是什么。私聊留给长在的那一方（管家），以后要和帮工档案私聊再加。
- **Mattermost 的 `O`/`P`/`D`/`G`**：公开和私有对一个主人没有区别；群私聊就是没名字的频道。串按 Discord 做成 channel，比 Mattermost 挂在根帖上的 `RootId` 合适：串有自己的跟帖的人、已读和投递。

## Acceptance criteria

- `type` 只有 `channel`、`direct`、`thread`；默认频道由 `Chat.default` 认出；代码里没有 `type === "general"`、`generalName` 和写死的 `#田头`（农场的词表除外）。
- 开机就有和管家的私聊；主人在里面说一句，管家醒来、答在私聊里；田头里在场的帮工收不到、未读不变。
- 接口表照上面的规矩：路径都是单数、第一段是 op 的模块，测试拦得住复数和挂错地方的路径。
- 页面的聊天页和农场的频道菜单列出私聊，点进去能说话。
- 测试：私聊的投递规则（`audience` 的黄金数据加私聊的情形）、开机建好且只有一个、管家答在私聊、页面打开私聊说一句收到回答。

## Risks

- 连接器（微信）和电话现在都落在默认频道。它们本该落在私聊，但改去处要定：已经接到某个频道的账号怎么办，电话的字幕给谁看。这一版不动，单独定。
- 老的库作废（照「内部不留兼容」）：田头和频道的消息、串都不在了，开机重建。
