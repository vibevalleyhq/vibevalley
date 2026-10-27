# Agent Note: channel 照 Discord 分成频道、私聊和串

Status: proposed

## Problem

说话的地方已经只有一个概念：`Channel`（[田头](docs/subsystems/channel.md)）。但它的 `type` 仍按「是不是田头」分：`general`、`channel`、`thread`。

- **田头被做成了一种类型。** 它其实只是农场默认的那个频道：能说的话、谁收到、怎么读，和别的频道一样，只是不能没有。代码里到处是 `type === "general"`；发消息不写 channel 就算田头（`SayRequest.channel` 可空），页面再把田头翻回 `undefined`。
- **没有私聊。** 主人想单独和管家说一句，只能在田头说：在场的帮工都收到（不叫醒，但进了它们的未读和摘要），田头也被刷满。微信本来就是一对一的，连接器却只能接到一个频道上。
- **发消息的接口不像别的接口。** 别的接口都是资源在前（`/channels/{id}/messages` 读历史），只有发消息是根上的一个动词 `POST /api/v1/say`；已读是设一个位置，却用 `POST`；`POST /api/v1/orchestrator/hear` 是「当前那一通电话里听到的一句」，挂在管家下面，和 `voice.heard` 只差一个 call id。

## Proposal

### 1. 三种 channel，照 Discord 的 type

| `type` | 是什么 | Discord |
|---|---|---|
| `channel` | 频道：田头和主人开的；有名字、说明、默认项目，在场的帮工都在里面 | `GUILD_TEXT` |
| `direct` | 私聊：主人和一个 agent，`peer` 是对面那个参与者；这一版只有管家 | `DM` |
| `thread` | 串：挂在 `parent` 频道的一条消息 `root` 下（工单串、计划串、没挂工单的帮工的 `talk` 串、在 `#频道:<号>` 下现开的） | `PUBLIC_THREAD` |

- **田头是默认的频道，不是一种类型。** 库里 `channel.general`（布尔，唯一的那一行为真），协议里 `Chat.general` 是它的 id（像 Discord 服务器的 `system_channel_id`）。页面和服务端认田头只看这个 id。
- **私聊在开机时和田头一起建好**（和管家的那一个，`peer` 是 `orchestrator`）；一个 `peer` 只有一个私聊（唯一索引）。没有名字，列表里用对面的名字。以后加和帮工的私聊、语音频道（`voice`）时只是多一种 `peer` 或 `type`。
- **帮工的 `talk` 串仍是串**：它挂在派活那条消息下面，带着派的是什么活，不是私聊。

### 2. 私聊里谁收到

两个人的地方，不用 @：主人说的每一句交给 `peer`，叫醒它（新的理由 `direct`）；`peer` 说的给主人（进未读）。@ 别人在私聊里只是字，不投递：别人不在这里。三道刹车照旧，只管 agent 叫醒 agent。管家在哪里被叫就回在哪里，所以它在私聊里答。

### 3. 接口按资源

| 现在 | 改成 |
|---|---|
| `POST /api/v1/say`（`channel.say`），不写 channel 就是田头 | `POST /api/v1/channels/{id}/messages`（`channel.send`），id 必填，田头用 `Chat.general` |
| `POST /api/v1/channels/{id}/read` | `PUT /api/v1/channels/{id}/read` |
| `POST /api/v1/orchestrator/hear`（`orchestrator.hear`） | `POST /api/v1/voice/heard`（`voice.hearCurrent`） |

一道检查，在 `packages/protocol` 的测试里：每个 op 的路径以它所属模块的资源开头（`channel.*` 在 `/api/v1/channels` 下），例外写明（`server.health` 是 `/api/v1/health`）。`/say` 这样的路径就进不来。

### 4. 页面

聊天页的侧栏和农场的频道菜单分两段：频道（田头在最前）、私聊（对面的名字和脸）。打开私聊和打开频道一样（`/chat/<id>`），输入框不用 @。

## Alternatives considered

- **田头留作一种类型**：要一直在每个分支里多写一种；它和别的频道只差「默认」这一点，用一个标记说清楚。
- **把帮工的 `talk` 串改成和帮工的私聊**：帮工是一次派活（Session），活完了就走；它的串挂在派活消息下面，读得出派的是什么。私聊留给长在的那一方（管家），以后要和帮工档案私聊再加。
- **Mattermost 的 `O`/`P`/`D`/`G`**：公开和私有对一个主人没有区别；群私聊就是没名字的频道。串按 Discord 做成 channel，比 Mattermost 挂在根帖上的 `RootId` 合适：串有自己的跟帖的人、已读和投递。

## Acceptance criteria

- `type` 只有 `channel`、`direct`、`thread`；田头由 `Chat.general` 认出；代码里没有 `type === "general"`。
- 开机就有和管家的私聊；主人在里面说一句，管家醒来、答在私聊里；田头里在场的帮工收不到、未读不变。
- 发消息是 `POST /api/v1/channels/{id}/messages`，已读是 `PUT`，电话里听到的一句在 `/api/v1/voice/heard`；`/api/v1/say` 和 `/api/v1/orchestrator/hear` 不在了；路径的检查拦得住挂错地方的接口。
- 页面的聊天页和农场的频道菜单列出私聊，点进去能说话。
- 测试：私聊的投递规则（`audience` 的黄金数据加私聊的情形）、开机建好且只有一个、管家答在私聊、页面打开私聊说一句收到回答。

## Risks

- 连接器（微信）和电话现在都落在田头。它们本该落在私聊，但改去处要定：已经接到某个频道的账号怎么办，电话的字幕给谁看。这一版不动，单独定。
- 老的库作废（照「内部不留兼容」）：田头和频道的消息、串都不在了，开机重建。
