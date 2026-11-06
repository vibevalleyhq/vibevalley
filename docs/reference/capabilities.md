# 能力表

由 `scripts/capabilities.ts` 从 `packages/protocol/src/api.ts` 的 `endpoints`（每个接口的 `can`）写出，不手改；`vp run docs:verify` 查它是不是最新。为什么这样分见 [先有能力，再有入口](docs/subsystems/core.md)。

| 谁 | 是谁 | 从哪个入口 |
|---|---|---|
| 主人 | 主人在农场那台电脑上 | 页面、命令行 |
| 连进来的设备 | 主人配对过的手机、另一台电脑 | 经「连接到本机」只放这一列打了 ✓ 的 |
| 管家 | 管家 | 它的工具：打了 ✓ 的每个接口是它的一个工具（`channel.message.list` 是 `channel_message_list`），`apps/server/src/tool` 照这一列给 |
| 帮工 | 在干活的帮工 | 经 `/mcp` 拿的工具，同上 |

`GET /api/v1/state`、`GET /api/v1/events` 和 `GET /api/v1/live` 是 SSE，不在 `endpoints` 里：主人和连进来的设备都能读；`/state` 给折好的帧，`/live` 只给页面要的三种 side event，`/events` 留给调试。接口都在 `/api/v1` 下；不兼容改动和 v1 的保留见 [接口版本](docs/subsystems/core.md#为什么这样)。

## server

服务端本身

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `server.health.get` | 服务端在不在、是哪个版本 | `/api/v1/server/health/get` | ✓ | ✓ |   |   |

## orchestrator

管家：上线、停下、旧账、评测

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `orchestrator.open` | 让管家上线，可以说话了 | `/api/v1/orchestrator/open` | ✓ | ✓ |   |   |
| `orchestrator.stop` | 停下管家这一轮，派出去的帮工接着干 | `/api/v1/orchestrator/stop` | ✓ | ✓ |   |   |
| `orchestrator.archive.list` | 列出或搜管家压掉的对话原文 | `/api/v1/orchestrator/archive/list` | ✓ | ✓ |   |   |
| `orchestrator.archive.get` | 读管家压掉的一份对话原文 | `/api/v1/orchestrator/archive/get` | ✓ | ✓ |   |   |
| `orchestrator.eval.create` | 把管家做错的一轮存成评测样例，写上该怎么做 | `/api/v1/orchestrator/eval/create` | ✓ | ✓ |   |   |

## setting

设置：模型、钥匙、目录和别的

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `setting.get` | 看设置 | `/api/v1/setting/get` | ✓ | ✓ |   |   |
| `setting.validate` | 这些设置会被拒的第一处，不存 | `/api/v1/setting/validate` | ✓ | ✓ |   |   |
| `setting.update` | 改设置 | `/api/v1/setting/update` | ✓ |   |   |   |

## channel

频道和私聊，和里面的消息

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `channel.message.send` | 在频道或串里发一条消息 | `/api/v1/channel/message/send` | ✓ | ✓ |   | ✓ |
| `channel.create` | 新建一个频道 | `/api/v1/channel/create` | ✓ | ✓ | ✓ |   |
| `channel.update` | 改一个频道 | `/api/v1/channel/update` | ✓ | ✓ | ✓ |   |
| `channel.default.set` | 设成默认频道：没指名的话都到这里 | `/api/v1/channel/default/set` | ✓ | ✓ |   |   |
| `channel.message.list` | 读一个频道的消息，可以往前翻 | `/api/v1/channel/message/list` | ✓ | ✓ | ✓ | ✓ |
| `channel.markRead` | 标成已读，读到这一条为止 | `/api/v1/channel/markRead` | ✓ | ✓ |   |   |
| `channel.message.update` | 改主人自己发的一条消息，不再通知谁 | `/api/v1/channel/message/update` | ✓ | ✓ |   |   |
| `channel.message.delete` | 删掉一条消息：字去掉，编号留着 | `/api/v1/channel/message/delete` | ✓ | ✓ |   |   |
| `channel.message.previewDelete` | 试删一条消息：说会删掉什么，不真删 | `/api/v1/channel/message/previewDelete` | ✓ | ✓ |   |   |
| `channel.message.search` | 搜消息 | `/api/v1/channel/message/search` | ✓ | ✓ |   |   |
| `channel.reaction.set` | 给一条消息加上表情，或撤回 | `/api/v1/channel/reaction/set` | ✓ | ✓ |   |   |
| `channel.pin.set` | 钉住一条消息，或取消钉住 | `/api/v1/channel/pin/set` | ✓ | ✓ |   |   |
| `channel.pin.list` | 列出频道里钉住的消息，新钉的在前 | `/api/v1/channel/pin/list` | ✓ | ✓ |   |   |
| `channel.thread.create` | 在一条消息下开串，已经有就用那个 | `/api/v1/channel/thread/create` | ✓ | ✓ |   |   |
| `channel.archive.set` | 归档一个频道或取回来，消息留着 | `/api/v1/channel/archive/set` | ✓ | ✓ |   |   |
| `channel.delete` | 删掉一个频道，连同它的串和消息 | `/api/v1/channel/delete` | ✓ | ✓ |   |   |
| `channel.previewDelete` | 试删一个频道：说会删掉什么，不真删 | `/api/v1/channel/previewDelete` | ✓ | ✓ |   |   |
| `channel.direct.create` | 打开和一份档案的私聊，没有就建 | `/api/v1/channel/direct/create` | ✓ | ✓ |   |   |
| `channel.notify.set` | 设一个频道的提醒：全部、只在 @主人 时、不提醒 | `/api/v1/channel/notify/set` | ✓ | ✓ |   |   |
| `channel.markUnread` | 标成未读，从这一条起 | `/api/v1/channel/markUnread` | ✓ | ✓ |   |   |
| `channel.list` | 列出全部频道和私聊，默认的在前 | `/api/v1/channel/list` | ✓ | ✓ | ✓ |   |
| `channel.unread.list` | 列出还没读完的频道和串，新的在前 | `/api/v1/channel/unread/list` | ✓ | ✓ |   | ✓ |
| `channel.attachment.create` | 上传一个附件，给消息带上 | `/api/v1/channel/attachment/create` | ✓ | ✓ |   |   |

## cron

定时任务

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `cron.create` | 新建一个定时任务 | `/api/v1/cron/create` | ✓ | ✓ | ✓ |   |
| `cron.list` | 列出全部定时任务 | `/api/v1/cron/list` | ✓ | ✓ | ✓ |   |
| `cron.update` | 改一个定时任务，只改给出的 | `/api/v1/cron/update` | ✓ | ✓ |   |   |
| `cron.delete` | 删掉一个定时任务 | `/api/v1/cron/delete` | ✓ | ✓ | ✓ |   |
| `cron.previewDelete` | 试删一个定时任务：说会删掉什么，不真删 | `/api/v1/cron/previewDelete` | ✓ | ✓ | ✓ |   |

## voice

通话和听写

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `voice.hear` | 交上正在通的那通电话里听到的一句 | `/api/v1/voice/hear` | ✓ | ✓ |   |   |
| `voice.moss.verify` | 试 MOSS 的钥匙能不能用，什么都不说 | `/api/v1/voice/moss/verify` | ✓ | ✓ |   |   |
| `voice.grant.create` | 拿通话用的声网令牌 | `/api/v1/voice/grant/create` | ✓ | ✓ |   |   |
| `voice.grant.renew` | 给通话换新的声网令牌 | `/api/v1/voice/grant/renew` | ✓ | ✓ |   |   |
| `voice.call.start` | 开始和管家通话 | `/api/v1/voice/call/start` | ✓ | ✓ |   |   |
| `voice.call.stop` | 挂断通话 | `/api/v1/voice/call/stop` | ✓ | ✓ |   |   |
| `voice.call.hear` | 交上通话里主人说的一句 | `/api/v1/voice/call/hear` | ✓ | ✓ |   |   |
| `voice.call.say` | 交上通话里管家说出的话 | `/api/v1/voice/call/say` | ✓ | ✓ |   |   |
| `voice.dictate` | 听写：把一段录音转成字 | `/api/v1/voice/dictate` | ✓ | ✓ |   |   |

## issue

工单：写、改、挪状态、评论、验收

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `issue.conversation.get` | 工单讨论串的位置 | `/api/v1/issue/conversation/get` | ✓ | ✓ |   |   |
| `issue.comment.create` | 给工单带一句话，交给它最新的帮工 | `/api/v1/issue/comment/create` | ✓ | ✓ | ✓ |   |
| `issue.diff.get` | 看工单的改动：提交、文件和 diff | `/api/v1/issue/diff/get` | ✓ | ✓ | ✓ |   |
| `issue.history.list` | 工单和它们的帮工历史，缺了记录的也列出 | `/api/v1/issue/history/list` | ✓ | ✓ |   |   |
| `issue.list` | 列出工单：默认是没关的，新的在前 | `/api/v1/issue/list` | ✓ | ✓ | ✓ |   |
| `issue.review` | 验收交回来的活：通过或打回；完成另挪状态 | `/api/v1/issue/review` | ✓ | ✓ | ✓ |   |
| `issue.split` | 把工单拆成子工单，马上开工 | `/api/v1/issue/split` | ✓ | ✓ |   | ✓ |
| `issue.get` | 看一张工单 | `/api/v1/issue/get` | ✓ | ✓ | ✓ |   |
| `issue.run.list` | 列出工单的每一轮 | `/api/v1/issue/run/list` | ✓ | ✓ |   |   |
| `issue.timeline.get` | 工单的时间线和每一轮加起来的花费 | `/api/v1/issue/timeline/get` | ✓ | ✓ |   |   |
| `issue.create` | 写一张新工单 | `/api/v1/issue/create` | ✓ | ✓ | ✓ |   |
| `issue.update` | 改一张工单 | `/api/v1/issue/update` | ✓ | ✓ | ✓ |   |
| `issue.delete` | 删掉一张工单 | `/api/v1/issue/delete` | ✓ | ✓ |   |   |
| `issue.previewDelete` | 试删一张工单：说会删掉什么，不真删 | `/api/v1/issue/previewDelete` | ✓ | ✓ |   |   |
| `issue.status.update` | 挪工单的状态：派活、再来一轮、完成或取消 | `/api/v1/issue/status/update` | ✓ | ✓ | ✓ |   |
| `issue.status.previewUpdate` | 试挪工单的状态：说会发生什么，不动手 | `/api/v1/issue/status/previewUpdate` | ✓ | ✓ | ✓ |   |
| `issue.refine` | 让一个帮工读代码，把备选的工单起草好 | `/api/v1/issue/refine` | ✓ | ✓ |   |   |

## session

帮工

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `session.stop` | 停下帮工这一轮，帮工还在 | `/api/v1/session/stop` | ✓ | ✓ | ✓ |   |
| `session.list` | 列出帮工，可以只看一份档案的 | `/api/v1/session/list` | ✓ | ✓ | ✓ | ✓ |
| `session.get` | 看一个帮工 | `/api/v1/session/get` | ✓ | ✓ |   |   |
| `session.event.list` | 读一个帮工的轨迹，从早到晚 | `/api/v1/session/event/list` | ✓ | ✓ |   |   |

## artifact

稿子：一起写的，和交上来的网页

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `artifact.list` | 列出某个频道或工单的稿子，不指定就是全部 | `/api/v1/artifact/list` | ✓ | ✓ | ✓ | ✓ |
| `artifact.get` | 看一篇稿子 | `/api/v1/artifact/get` | ✓ | ✓ | ✓ | ✓ |
| `artifact.content.get` | 读稿子的正文：网页的一版，或块写成的 Markdown | `/api/v1/artifact/content/get` | ✓ | ✓ | ✓ | ✓ |
| `artifact.create` | 新建稿子：空的一篇来一起写，或交上来一稿 | `/api/v1/artifact/create` | ✓ | ✓ | ✓ | ✓ |
| `artifact.version.create` | 给网页稿子交新的一版，旧的留着 | `/api/v1/artifact/version/create` | ✓ | ✓ | ✓ | ✓ |
| `artifact.html.edit` | 在网页稿子里换掉一段字，成为新的一版 | `/api/v1/artifact/html/edit` | ✓ | ✓ |   |   |
| `artifact.update` | 给稿子改标题 | `/api/v1/artifact/update` | ✓ | ✓ |   |   |
| `artifact.delete` | 删掉一篇稿子 | `/api/v1/artifact/delete` | ✓ | ✓ |   |   |
| `artifact.previewDelete` | 试删一篇稿子：说会删掉什么，不真删 | `/api/v1/artifact/previewDelete` | ✓ | ✓ |   |   |
| `artifact.block.list` | 按顺序列出稿子现有的每一块 | `/api/v1/artifact/block/list` | ✓ | ✓ |   |   |
| `artifact.submit` | 以主人的身份交一批块的操作，按顺序一次做完 | `/api/v1/artifact/submit` | ✓ | ✓ |   |   |
| `artifact.block.create` | 在稿子里插一块 | `/api/v1/artifact/block/create` | ✓ | ✓ | ✓ | ✓ |
| `artifact.block.update` | 改一块的字、类型或属性 | `/api/v1/artifact/block/update` | ✓ | ✓ | ✓ | ✓ |
| `artifact.block.delete` | 删掉稿子里的一块和它的子块 | `/api/v1/artifact/block/delete` | ✓ | ✓ | ✓ | ✓ |
| `artifact.block.previewDelete` | 试删一块：说会删掉什么，不真删 | `/api/v1/artifact/block/previewDelete` | ✓ | ✓ | ✓ | ✓ |
| `artifact.suggestion.list` | 列出稿子上的改写建议，没答的和答过的 | `/api/v1/artifact/suggestion/list` | ✓ | ✓ |   |   |
| `artifact.suggestion.create` | 对主人写的一块提改写建议 | `/api/v1/artifact/suggestion/create` | ✓ | ✓ |   |   |
| `artifact.suggestion.accept` | 接受一条改写建议 | `/api/v1/artifact/suggestion/accept` | ✓ | ✓ |   |   |
| `artifact.suggestion.reject` | 拒绝一条改写建议 | `/api/v1/artifact/suggestion/reject` | ✓ | ✓ |   |   |
| `artifact.markdown.get` | 把一起写的稿子读成 Markdown | `/api/v1/artifact/markdown/get` | ✓ | ✓ |   |   |
| `artifact.demo` | 开演示：几个帮工一起写一篇稿子，不花模型的钱 | `/api/v1/artifact/demo` | ✓ |   |   |   |

## game

里程碑和称号

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `game.achievement.list` | 列出全部里程碑 | `/api/v1/game/achievement/list` | ✓ | ✓ |   |   |
| `game.title.set` | 挑一个挂在农场卡上的称号 | `/api/v1/game/title/set` | ✓ | ✓ |   |   |

## runtime

农机：机器上的编码 agent

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `runtime.list` | 列出全部农机 | `/api/v1/runtime/list` | ✓ | ✓ |   |   |
| `runtime.refresh` | 重新探测一台农机 | `/api/v1/runtime/refresh` | ✓ | ✓ |   |   |
| `runtime.setting.update` | 改一台农机的设置：开关、路径、默认模型、预算 | `/api/v1/runtime/setting/update` | ✓ |   |   |   |

## repo

仓库：工作目录下的 git 仓库

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `repo.pr.submit` | 发布已有本地分支 | `/api/v1/repo/pr/submit` | ✓ |   |   |   |
| `repo.list` | 列出全部仓库 | `/api/v1/repo/list` | ✓ | ✓ | ✓ |   |
| `repo.validate` | 新建仓库会被拒的第一处，不真建 | `/api/v1/repo/validate` | ✓ | ✓ |   |   |
| `repo.create` | 新建一个仓库 | `/api/v1/repo/create` | ✓ | ✓ |   |   |
| `repo.language.list` | 仓库用了哪些语言 | `/api/v1/repo/language/list` | ✓ | ✓ |   |   |
| `repo.template.list` | 仓库的工单模板，按它的栈填好 | `/api/v1/repo/template/list` | ✓ | ✓ |   |   |
| `repo.activity.get` | 仓库的提交：每天几次、谁提交的 | `/api/v1/repo/activity/get` | ✓ | ✓ |   |   |

## github

GitHub 的检测：gh 装没装、登没登录

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `github.get` | 看 gh 装没装、登没登录 | `/api/v1/github/get` | ✓ | ✓ |   |   |
| `github.refresh` | 重新检测 GitHub，顺带刷新开着的 PR | `/api/v1/github/refresh` | ✓ | ✓ |   |   |

## agent

档案：派活时指给谁

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `agent.list` | 列出全部档案 | `/api/v1/agent/list` | ✓ | ✓ |   |   |
| `agent.validate` | 看每份档案现在派活哪里不对，没存的草稿也看 | `/api/v1/agent/validate` | ✓ | ✓ |   |   |
| `agent.create` | 新建一份档案 | `/api/v1/agent/create` | ✓ |   |   |   |
| `agent.update` | 改一份档案（整份写入） | `/api/v1/agent/update` | ✓ |   |   |   |
| `agent.delete` | 删掉一份档案 | `/api/v1/agent/delete` | ✓ |   |   |   |
| `agent.previewDelete` | 试删一份档案：说会删掉什么，不真删 | `/api/v1/agent/previewDelete` | ✓ |   |   |   |
| `agent.template.list` | 列出能装的档案模板：内置的，再是加进来的 | `/api/v1/agent/template/list` | ✓ | ✓ |   |   |
| `agent.template.install` | 从模板装一份新档案 | `/api/v1/agent/template/install` | ✓ |   |   |   |
| `agent.template.update` | 照模板现在的版本重做档案，本机的设置留着 | `/api/v1/agent/template/update` | ✓ |   |   |   |
| `agent.template.add` | 把本机的一个模板文件夹加进来，不装 | `/api/v1/agent/template/add` | ✓ |   |   |   |
| `agent.template.delete` | 删掉加进来的模板，从它装的档案留着 | `/api/v1/agent/template/delete` | ✓ |   |   |   |
| `agent.template.previewDelete` | 试删一个档案模板：说会删掉什么，不真删 | `/api/v1/agent/template/previewDelete` | ✓ |   |   |   |

## skill

技能

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `skill.list` | 列出全部技能 | `/api/v1/skill/list` | ✓ | ✓ |   |   |
| `skill.create` | 新建一个技能 | `/api/v1/skill/create` | ✓ |   |   |   |
| `skill.update` | 改一个技能 | `/api/v1/skill/update` | ✓ |   |   |   |
| `skill.delete` | 删掉一个技能 | `/api/v1/skill/delete` | ✓ |   |   |   |
| `skill.previewDelete` | 试删一个技能：说会删掉什么，不真删 | `/api/v1/skill/previewDelete` | ✓ |   |   |   |

## pkm

笔记：记一句、搜、雷达、日记和页

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `pkm.page.list` | 列出笔记库里的每一页，新的在前 | `/api/v1/pkm/page/list` | ✓ | ✓ |   |   |
| `pkm.page.get` | 看一页：引用读出来，带反链和没答的批注 | `/api/v1/pkm/page/get` | ✓ | ✓ | ✓ | ✓ |
| `pkm.page.save` | 新建一页，或改同名那页的属性和文件夹 | `/api/v1/pkm/page/save` | ✓ | ✓ |   |   |
| `pkm.page.move` | 把一页挪到 PARA 的另一个文件夹 | `/api/v1/pkm/page/move` | ✓ | ✓ |   |   |
| `pkm.page.rename` | 给一页改名或并进同名的页，链接跟着改 | `/api/v1/pkm/page/rename` | ✓ | ✓ |   |   |
| `pkm.page.export` | 把一页导出成干净的 Markdown | `/api/v1/pkm/page/export` | ✓ | ✓ |   |   |
| `pkm.block.apply` | 对一页按顺序施加块的操作，一次写回 | `/api/v1/pkm/block/apply` | ✓ | ✓ |   |   |
| `pkm.search` | 搜笔记 | `/api/v1/pkm/search` | ✓ | ✓ | ✓ | ✓ |
| `pkm.capture` | 在今天的日记里记一句，标上 #inbox | `/api/v1/pkm/capture` | ✓ | ✓ | ✓ | ✓ |
| `pkm.source.get` | 一页文件的原文（带块的 id）和它上次写的时间 | `/api/v1/pkm/source/get` | ✓ | ✓ |   |   |
| `pkm.source.update` | 用改过的原文重写一页；这期间文件被改过就不写 | `/api/v1/pkm/source/update` | ✓ | ✓ |   |   |
| `pkm.journal.open` | 打开某一天的日记，没有就建 | `/api/v1/pkm/journal/open` | ✓ | ✓ |   |   |
| `pkm.radar.get` | 回顾雷达：收件箱里的、搁着的仓库、过期的块 | `/api/v1/pkm/radar/get` | ✓ | ✓ |   |   |
| `pkm.comment.list` | 列出批注和改写，可以只看一页的 | `/api/v1/pkm/comment/list` | ✓ | ✓ |   |   |
| `pkm.comment.suggest` | 对一块提改写，留住它的链接和引用 | `/api/v1/pkm/comment/suggest` | ✓ | ✓ | ✓ | ✓ |
| `pkm.comment.resolve` | 接受或拒绝一条改写 | `/api/v1/pkm/comment/resolve` | ✓ | ✓ |   |   |
| `pkm.clip.create` | 把一个网页剪藏成一页资源 | `/api/v1/pkm/clip/create` | ✓ | ✓ |   |   |
| `pkm.cluster.create` | 把写到一个话题的块聚成一页资源 | `/api/v1/pkm/cluster/create` | ✓ | ✓ |   |   |
| `pkm.undo` | 撤销笔记的上一次改动 | `/api/v1/pkm/undo` | ✓ |   |   |   |
| `pkm.scan` | 重读磁盘上改过的笔记文件 | `/api/v1/pkm/scan` | ✓ | ✓ |   |   |

## memory

档案的记性

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `memory.list` | 列出一份档案的记性：库里的和配置的来源 | `/api/v1/memory/list` | ✓ | ✓ |   |   |
| `memory.recall` | 看档案对这个仓库和这句话会想起什么 | `/api/v1/memory/recall` | ✓ | ✓ |   |   |
| `memory.create` | 给一份档案记一条记性 | `/api/v1/memory/create` | ✓ | ✓ | ✓ | ✓ |
| `memory.search` | 按字搜记性，不指定档案就搜全部 | `/api/v1/memory/search` | ✓ | ✓ | ✓ | ✓ |
| `memory.delete` | 删掉档案的一条记性 | `/api/v1/memory/delete` | ✓ | ✓ |   |   |
| `memory.previewDelete` | 试删一条记性：说会删掉什么，不真删 | `/api/v1/memory/previewDelete` | ✓ | ✓ |   |   |

## connector

连接器：把微信、飞书、QQ 接到频道

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `connector.list` | 列出微信、飞书、QQ 连接器和它们的状况 | `/api/v1/connector/list` | ✓ | ✓ |   |   |
| `connector.login` | 登录一个连接器 | `/api/v1/connector/login` | ✓ |   |   |   |
| `connector.verify` | 交验证码，接着连接器的登录 | `/api/v1/connector/verify` | ✓ |   |   |   |
| `connector.logout` | 退出一个连接器的登录 | `/api/v1/connector/logout` | ✓ |   |   |   |
| `connector.channel.set` | 设连接器的消息进哪个频道 | `/api/v1/connector/channel/set` | ✓ |   |   |   |

## lan

连接到本机：开关、配对、设备

| 操作 | 做什么 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|---|
| `lan.get` | 看「连接到本机」开没开、有哪些设备 | `/api/v1/lan/get` | ✓ |   |   |   |
| `lan.update` | 打开或关上「连接到本机」 | `/api/v1/lan/update` | ✓ |   |   |   |
| `lan.pairing.start` | 开始配对，给出配对码 | `/api/v1/lan/pairing/start` | ✓ |   |   |   |
| `lan.pairing.stop` | 停止配对 | `/api/v1/lan/pairing/stop` | ✓ |   |   |   |
| `lan.pairing.previewStop` | 试停配对：说会怎样，不真停 | `/api/v1/lan/pairing/previewStop` | ✓ |   |   |   |
| `lan.pairing.answer` | 放行或拒绝来配对的设备 | `/api/v1/lan/pairing/answer` | ✓ |   |   |   |
| `lan.device.delete` | 移除一台配对过的设备 | `/api/v1/lan/device/delete` | ✓ |   |   |   |
| `lan.device.previewDelete` | 试移除一台设备：说会怎样，不真移除 | `/api/v1/lan/device/previewDelete` | ✓ |   |   |   |
| `lan.pair` | 用配对码把这台设备配上 | `/api/v1/lan/pair` | ✓ | ✓ |   |   |
| `lan.me.get` | 发这个请求的设备是哪台 | `/api/v1/lan/me/get` | ✓ | ✓ |   |   |
