# 能力表

由 `scripts/gen/capabilities.ts` 从 `packages/protocol/src/api.ts` 的 `endpoints`（每个接口的 `can`）写出，不手改；`vp run docs:verify` 查它是不是最新。为什么这样分见 [先有能力，再有入口](docs/subsystems/core.md)。

| 谁 | 是谁 | 从哪个入口 |
|---|---|---|
| 用户 | 用户在运行 VibeValley 的这台电脑上 | 页面、命令行 |
| 连进来的设备 | 用户配对过的手机、另一台电脑 | 「连接到本机」随手机壳砍掉了，Rust 服务端没有这道门；这一列留在契约里 |
| 主助手 | 主助手 | 它的工具；Rust 服务端的工具清单在 `crates/server/assets/tools/orchestrator.json`，以那份为准 |
| 执行会话 | 运行中的执行会话 | 经 `/mcp` 拿的工具，清单在 `crates/server/assets/tools/helper.json` |

`GET /api/v1/slice/{name}`（`name` 为 `board`、`sessions`、`collab`、`inbox`、`ops` 五个核心切片或独立的 `farm` 画面）、`GET /api/v1/live` 和 `GET /api/v1/events` 不在 `endpoints` 里：用户和连进来的设备都能读；`/slice/{name}` 带 `Accept: application/json` 或 `?once=1` 返回当前 JSON 快照，否则是支持 `Last-Event-ID`／`?after=<seq>` 续读的 SSE，`/live`（别名 `/events`）只推页面要的三种实时 side event。接口都在 `/api/v1` 下；不兼容改动和 v1 的保留见 [接口版本](docs/subsystems/core.md#为什么这样)。

## server

服务端本身

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `server.health.get` | 服务端在不在、是哪个版本 | `/api/v1/server/health/get` | ✓ | ✓ |   |   |

## debug

开发者工具：快照、时间线、轨迹、拓扑、故障注入和诊断包导出

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `debug.snapshot` | 读取开发者工具全景快照（概览、路由、覆盖、拓扑、状态缓存与近期时间线） | `/api/v1/debug/snapshot` | ✓ |   |   |   |
| `debug.timeline.list` | 按通道和游标查询时间线事件 | `/api/v1/debug/timeline/list` | ✓ |   |   |   |
| `debug.timeline.clear` | 清空开发者工具时间线缓冲区 | `/api/v1/debug/timeline/clear` | ✓ |   |   |   |
| `debug.trajectory.list` | 列出可检视的执行会话、工作区对话与主助手轨迹摘要 | `/api/v1/debug/trajectory/list` | ✓ |   |   |   |
| `debug.trajectory.get` | 读取单条执行会话、工作区对话或主助手轨迹详情与原始帧 | `/api/v1/debug/trajectory/get` | ✓ |   |   |   |
| `debug.trajectory.export` | cap.op.debug.trajectory.export | `/api/v1/debug/trajectory/export` | ✓ |   |   |   |
| `debug.override.set` | 更新故障注入与延迟覆盖配置 | `/api/v1/debug/override/set` | ✓ |   |   |   |
| `debug.bundle.export` | 导出脱敏后的本机诊断包 | `/api/v1/debug/bundle/export` | ✓ |   |   |   |

## remote

远程访问：开关、局域网直连与可选 Tailscale 监听、设备配对与撤销

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `remote.status` | 查看远程访问状态、局域网 IPv4 / Tailscale 信息与已配对设备 | `/api/v1/remote/status` | ✓ |   |   |   |
| `remote.enable` | 开启远程访问监听（默认绑定在线 Tailscale IPv4、检测到的局域网 IPv4 或回环地址） | `/api/v1/remote/enable` | ✓ |   |   |   |
| `remote.disable` | 关闭远程访问监听 | `/api/v1/remote/disable` | ✓ |   |   |   |
| `remote.pair.create` | 生成 5 分钟有效的一次性配对码与配对深链 | `/api/v1/remote/pair/create` | ✓ |   |   |   |
| `remote.pair.exchange` | 用一次性配对码交换持久设备令牌 | `/api/v1/remote/pair/exchange` | ✓ | ✓ |   |   |
| `remote.device.revoke` | 撤销一台已配对设备的访问令牌 | `/api/v1/remote/device/revoke` | ✓ |   |   |   |
| `remote.whoami` | 查看当前调用者与已配对设备身份 | `/api/v1/remote/whoami` | ✓ | ✓ |   |   |

## machine

设备：本机与远程执行机器

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `machine.list` | 列出当前可见的本机与远程执行设备 | `/api/v1/machine/list` | ✓ | ✓ |   |   |

## orchestrator

主助手：上线、停下、评测

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `orchestrator.open` | 让主助手上线，可以说话了 | `/api/v1/orchestrator/open` | ✓ | ✓ |   |   |
| `orchestrator.stop` | 停下主助手这一轮，派出去的执行会话接着干 | `/api/v1/orchestrator/stop` | ✓ | ✓ |   |   |
| `orchestrator.eval.create` | 把主助手做错的一轮存成评测样例，写上该怎么做 | `/api/v1/orchestrator/eval/create` | ✓ | ✓ |   |   |
| `orchestrator.approval.list` | 列出主助手等待审批的工具调用 | `/api/v1/orchestrator/approval/list` | ✓ |   |   |   |
| `orchestrator.approval.resolve` | 批准或拒绝主助手的工具调用 | `/api/v1/orchestrator/approval/resolve` | ✓ |   |   |   |

## setting

设置：模型、钥匙、目录和别的

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `setting.get` | 看设置 | `/api/v1/setting/get` | ✓ | ✓ |   |   |
| `setting.validate` | 这些设置会被拒的第一处，不存 | `/api/v1/setting/validate` | ✓ | ✓ |   |   |
| `setting.update` | 改设置 | `/api/v1/setting/update` | ✓ |   |   |   |

## provider



| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `provider.get` | 读取供应商连接和默认用途，密钥只显示提示 | `/api/v1/provider/get` | ✓ |   |   |   |
| `provider.update` | 按版本保存供应商连接和默认用途 | `/api/v1/provider/update` | ✓ |   |   |   |
| `provider.voice.list` | 查询指定 MOSS 账号的一页音色，不生成音频 | `/api/v1/provider/voice/list` | ✓ |   |   |   |
| `provider.model.list` | 查询已配置 MOSS 账号的可用模型，不发推理请求 | `/api/v1/provider/model/list` | ✓ |   |   |   |

## media



| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `media.dialogue.create` | 使用指定账号的音色生成多人对话 | `/api/v1/media/dialogue/create` | ✓ |   | ✓ |   |
| `media.voiceDesign.create` | 设计合成音色试听，不保存可复用音色 | `/api/v1/media/voiceDesign/create` | ✓ |   | ✓ |   |
| `media.clone.create` | 克隆已明确授权的本机声音样本 | `/api/v1/media/clone/create` | ✓ |   |   |   |
| `media.transcription.create` | 转写已授权上传的音频，可区分说话人 | `/api/v1/media/transcription/create` | ✓ |   |   |   |
| `media.audio.resume` | 继续查询同一个已知音频任务，不重复生成 | `/api/v1/media/audio/resume` | ✓ |   |   |   |
| `media.audio.previewCleanup` | 预览清理已知远端音频文件，不实际改动 | `/api/v1/media/audio/previewCleanup` | ✓ |   |   |   |
| `media.audio.cleanup` | 清理已知远端音频文件，不重复转写或合成 | `/api/v1/media/audio/cleanup` | ✓ |   |   |   |
| `media.input.create` | 为媒体输入预留有限的本机空间，不上传给供应商 | `/api/v1/media/input/create` | ✓ |   |   |   |
| `media.input.adopt` | 把媒体库里的一个文件拿来当媒体输入，照上传一样检查 | `/api/v1/media/input/adopt` | ✓ |   |   |   |
| `media.input.list` | 列出本机的媒体输入 | `/api/v1/media/input/list` | ✓ |   |   |   |
| `media.input.delete` | 删除没有被任务保留的本机媒体输入 | `/api/v1/media/input/delete` | ✓ |   |   |   |
| `media.input.previewDelete` | 预览删除本机媒体输入，不实际改动 | `/api/v1/media/input/previewDelete` | ✓ |   |   |   |
| `media.image.create` | 创建生图任务，同一编号不重复生成 | `/api/v1/media/image/create` | ✓ |   | ✓ |   |
| `media.understanding.create` | 确认账号和上传许可后理解选中的本机输入 | `/api/v1/media/understanding/create` | ✓ |   |   |   |
| `media.understanding.authorize` | 登记不可变理解请求，只授权指定频道的主助手执行一次 | `/api/v1/media/understanding/authorize` | ✓ |   |   |   |
| `media.understanding.start` | 主助手按已授权任务编号执行理解，不接受新的输入或授权声明 | `/api/v1/media/understanding/start` |   |   | ✓ |   |
| `media.speech.create` | 创建单人语音任务，生成后下载到本机，不重复提交同一编号 | `/api/v1/media/speech/create` | ✓ |   | ✓ |   |
| `media.speech.resume` | 继续查询已知语音任务，不重新提交 | `/api/v1/media/speech/resume` | ✓ |   |   |   |
| `media.understanding.cleanup` | 清理已知远端文件，不重复理解请求 | `/api/v1/media/understanding/cleanup` | ✓ |   |   |   |
| `media.job.get` | 读取生成任务 | `/api/v1/media/job/get` | ✓ |   | ✓ |   |
| `media.job.cancel` | 取消本机等待，不保证停止厂商计费 | `/api/v1/media/job/cancel` | ✓ |   | ✓ |   |
| `media.job.previewRelease` | 预览释放本机音频资产并放弃后续恢复 | `/api/v1/media/job/previewRelease` | ✓ |   |   |   |
| `media.job.release` | 释放这个任务的本机音频资产，不删除共享资产，也不停止厂商计费 | `/api/v1/media/job/release` | ✓ |   |   |   |
| `media.job.download` | 只重试结果下载，不重新生成 | `/api/v1/media/job/download` | ✓ |   | ✓ |   |
| `media.job.list` | 列出最近生成任务 | `/api/v1/media/job/list` | ✓ |   | ✓ |   |

## library



| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `library.item.list` | 列出媒体库：生成的、你上传的、执行会话拿回来的文件，可按来路和种类筛 | `/api/v1/library/item/list` | ✓ | ✓ | ✓ | ✓ |
| `library.item.add` | 把文件放进媒体库：你上传好的附件，或主助手、执行会话给的网址或工作区里的文件 | `/api/v1/library/item/add` | ✓ | ✓ | ✓ | ✓ |
| `library.item.delete` | 从媒体库拿掉一个文件（发过它的消息仍能打开） | `/api/v1/library/item/delete` | ✓ | ✓ |   |   |
| `library.item.previewDelete` | 试拿掉：说会怎样，不真拿掉 | `/api/v1/library/item/previewDelete` | ✓ | ✓ |   |   |

## channel

频道和私聊，和里面的消息

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `channel.message.send` | 在频道或串里发一条消息 | `/api/v1/channel/message/send` | ✓ | ✓ |   | ✓ |
| `channel.create` | 新建一个频道 | `/api/v1/channel/create` | ✓ | ✓ | ✓ |   |
| `channel.update` | 改一个频道 | `/api/v1/channel/update` | ✓ | ✓ | ✓ |   |
| `channel.message.list` | 读一个频道的消息，可以往前翻 | `/api/v1/channel/message/list` | ✓ | ✓ | ✓ | ✓ |
| `channel.markRead` | 标成已读，读到这一条为止 | `/api/v1/channel/markRead` | ✓ | ✓ |   |   |
| `channel.message.update` | 改你自己发的一条消息，不再通知谁 | `/api/v1/channel/message/update` | ✓ | ✓ |   |   |
| `channel.message.delete` | 删掉一条消息：字去掉，编号留着 | `/api/v1/channel/message/delete` | ✓ | ✓ |   |   |
| `channel.message.previewDelete` | 试删一条消息：说会删掉什么，不真删 | `/api/v1/channel/message/previewDelete` | ✓ | ✓ |   |   |
| `channel.message.search` | 搜消息 | `/api/v1/channel/message/search` | ✓ | ✓ |   |   |
| `channel.reaction.set` | 给一条消息加上表情，或撤回 | `/api/v1/channel/reaction/set` | ✓ | ✓ |   |   |
| `channel.pin.set` | 钉住一条消息，或取消钉住 | `/api/v1/channel/pin/set` | ✓ | ✓ |   |   |
| `channel.pin.list` | 列出频道里钉住的消息，新钉的在前 | `/api/v1/channel/pin/list` | ✓ | ✓ |   |   |
| `channel.thread.create` | 在一条消息下开话题，已经有就用那个 | `/api/v1/channel/thread/create` | ✓ | ✓ |   |   |
| `channel.archive.set` | 归档一个频道或取回来，消息留着 | `/api/v1/channel/archive/set` | ✓ | ✓ |   |   |
| `channel.delete` | 删掉一个频道，连同它的话题和消息 | `/api/v1/channel/delete` | ✓ | ✓ |   |   |
| `channel.previewDelete` | 试删一个频道：说会删掉什么，不真删 | `/api/v1/channel/previewDelete` | ✓ | ✓ |   |   |
| `channel.direct.create` | 打开和一份角色的私聊，没有就建 | `/api/v1/channel/direct/create` | ✓ | ✓ |   |   |
| `channel.notify.set` | 设一个频道的提醒：全部、只在有人 @你 时、不提醒 | `/api/v1/channel/notify/set` | ✓ | ✓ |   |   |
| `channel.markUnread` | 标成未读，从这一条起 | `/api/v1/channel/markUnread` | ✓ | ✓ |   |   |
| `channel.list` | 列出全部频道和私聊，默认的在前 | `/api/v1/channel/list` | ✓ | ✓ | ✓ |   |
| `channel.unread.list` | 列出还没读完的频道和话题，新的在前 | `/api/v1/channel/unread/list` | ✓ | ✓ |   | ✓ |

## cron

定时任务

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `cron.create` | 新建一个定时任务 | `/api/v1/cron/create` | ✓ | ✓ | ✓ |   |
| `cron.list` | 列出全部定时任务 | `/api/v1/cron/list` | ✓ | ✓ | ✓ |   |
| `cron.update` | 改一个定时任务，只改给出的 | `/api/v1/cron/update` | ✓ | ✓ |   |   |
| `cron.delete` | 删掉一个定时任务 | `/api/v1/cron/delete` | ✓ | ✓ | ✓ |   |
| `cron.previewDelete` | 试删一个定时任务：说会删掉什么，不真删 | `/api/v1/cron/previewDelete` | ✓ | ✓ | ✓ |   |

## voice

MOSS Live 语音通话

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `voice.hear` | 交上正在通的那通电话里听到的一句 | `/api/v1/voice/hear` | ✓ | ✓ |   |   |
| `voice.moss.verify` | 试 MOSS 的钥匙能不能用，什么都不说 | `/api/v1/voice/moss/verify` | ✓ |   |   |   |
| `voice.grant.create` | 为 MOSS Live 通话签发频道与会话标识 | `/api/v1/voice/grant/create` | ✓ | ✓ |   |   |
| `voice.call.start` | 开始和主助手通话 | `/api/v1/voice/call/start` | ✓ | ✓ |   |   |
| `voice.call.stop` | 挂断通话 | `/api/v1/voice/call/stop` | ✓ | ✓ |   |   |
| `voice.call.hear` | 交上通话里你说的一句 | `/api/v1/voice/call/hear` | ✓ | ✓ |   |   |
| `voice.call.say` | 交上通话里主助手说出的话 | `/api/v1/voice/call/say` | ✓ | ✓ |   |   |
| `voice.asr.start` | cap.op.voice.asr.start | `/api/v1/voice/asr/start` | ✓ | ✓ |   |   |
| `voice.asr.stop` | cap.op.voice.asr.stop | `/api/v1/voice/asr/stop` | ✓ | ✓ |   |   |
| `voice.asr.transcribe` | cap.op.voice.asr.transcribe | `/api/v1/voice/asr/transcribe` | ✓ | ✓ |   |   |

## issue

任务：写、改、挪状态、评论、验收

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `issue.conversation.get` | 任务讨论串的位置 | `/api/v1/issue/conversation/get` | ✓ | ✓ |   |   |
| `issue.comment.create` | 给任务带一句话，交给它最新的执行会话 | `/api/v1/issue/comment/create` | ✓ | ✓ | ✓ |   |
| `issue.diff.get` | 看任务的改动：提交、文件和 diff | `/api/v1/issue/diff/get` | ✓ | ✓ | ✓ |   |
| `issue.history.list` | 任务和它们的执行会话历史，缺了记录的也列出 | `/api/v1/issue/history/list` | ✓ | ✓ |   |   |
| `issue.list` | 列出任务：默认是没关的，新的在前 | `/api/v1/issue/list` | ✓ | ✓ | ✓ |   |
| `issue.review` | 验收交回来的活：通过或打回；完成另挪状态 | `/api/v1/issue/review` | ✓ | ✓ | ✓ |   |
| `issue.split` | 把任务拆成子任务，马上开工 | `/api/v1/issue/split` | ✓ | ✓ |   | ✓ |
| `issue.get` | 看一个任务 | `/api/v1/issue/get` | ✓ | ✓ | ✓ |   |
| `issue.run.list` | 列出任务的每一轮 | `/api/v1/issue/run/list` | ✓ | ✓ |   |   |
| `issue.timeline.get` | 任务的时间线和每一轮加起来的花费 | `/api/v1/issue/timeline/get` | ✓ | ✓ |   |   |
| `issue.create` | 写一张新任务 | `/api/v1/issue/create` | ✓ | ✓ | ✓ |   |
| `issue.update` | 改一个任务 | `/api/v1/issue/update` | ✓ | ✓ | ✓ |   |
| `issue.delete` | 删掉一个任务 | `/api/v1/issue/delete` | ✓ | ✓ |   |   |
| `issue.previewDelete` | 试删一个任务：说会删掉什么，不真删 | `/api/v1/issue/previewDelete` | ✓ | ✓ |   |   |
| `issue.status.update` | 挪任务的状态：派活、再来一轮、完成或取消 | `/api/v1/issue/status/update` | ✓ | ✓ | ✓ |   |
| `issue.status.previewUpdate` | 试挪任务的状态：说会发生什么，不动手 | `/api/v1/issue/status/previewUpdate` | ✓ | ✓ | ✓ |   |
| `issue.refine` | 让一个执行会话读代码，把备选的任务起草好 | `/api/v1/issue/refine` | ✓ | ✓ | ✓ |   |
| `issue.retro.get` | 按时间窗口统计任务吞吐、阶段耗时、逾期情况、返工率与按仓库、标签、角色分布 | `/api/v1/issue/retro/get` | ✓ | ✓ | ✓ |   |
| `issue.digest.get` | cap.op.issue.digest.get | `/api/v1/issue/digest/get` | ✓ | ✓ | ✓ |   |
| `issue.triage.list` | cap.op.issue.triage.list | `/api/v1/issue/triage/list` | ✓ | ✓ | ✓ |   |
| `issue.triage.suggest` | cap.op.issue.triage.suggest | `/api/v1/issue/triage/suggest` | ✓ | ✓ | ✓ |   |
| `issue.triage.confirm` | cap.op.issue.triage.confirm | `/api/v1/issue/triage/confirm` | ✓ | ✓ |   |   |
| `issue.triage.dismiss` | cap.op.issue.triage.dismiss | `/api/v1/issue/triage/dismiss` | ✓ | ✓ |   |   |

## session

执行会话

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `session.stop` | 停下执行会话这一轮，执行会话还在 | `/api/v1/session/stop` | ✓ | ✓ | ✓ |   |
| `session.list` | 列出执行会话，可以只看一份角色的 | `/api/v1/session/list` | ✓ | ✓ | ✓ | ✓ |
| `session.get` | 看一个执行会话 | `/api/v1/session/get` | ✓ | ✓ |   |   |
| `session.event.list` | 读一个执行会话的轨迹，从早到晚 | `/api/v1/session/event/list` | ✓ | ✓ |   |   |
| `session.openWorkspace` | 在工作区目录打开或续接直连对话会话 | `/api/v1/session/openWorkspace` | ✓ | ✓ |   |   |
| `session.closeWorkspace` | 关闭工作区直连对话会话并回收执行进程 | `/api/v1/session/closeWorkspace` | ✓ | ✓ |   |   |
| `session.send` | 向直连对话会话发消息（空闲启轮，运行中引导） | `/api/v1/session/send` | ✓ | ✓ |   |   |
| `session.respondPermission` | 答复会话的工具权限请求 | `/api/v1/session/respondPermission` | ✓ | ✓ |   |   |
| `session.respondInteraction` | 回复会话的交互式提问 | `/api/v1/session/respondInteraction` | ✓ | ✓ |   |   |
| `session.setConfig` | 调整工作区会话的模型、推理强度或权限模式 | `/api/v1/session/setConfig` | ✓ | ✓ |   |   |
| `session.childTranscript` | 读取子代理或协作组员最近的轨迹步骤 | `/api/v1/session/childTranscript` | ✓ | ✓ |   |   |
| `session.compact` | cap.op.session.compact | `/api/v1/session/compact` | ✓ | ✓ |   |   |
| `session.runCode` | cap.op.session.runCode | `/api/v1/session/runCode` | ✓ | ✓ |   |   |

## note

笔记：按目录组织、支持 3+1 基元（块文档、多维库、自由画布、媒体记录）、页面树、双向链接与多人多代理实时协作

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `note.list` | 列出某个频道、工单或父页面下的笔记，不指定就是全部 | `/api/v1/note/list` | ✓ | ✓ | ✓ | ✓ |
| `note.get` | 看一篇笔记 | `/api/v1/note/get` | ✓ | ✓ | ✓ | ✓ |
| `note.content.get` | 读笔记主入口文件内容（可指定历史版本快照） | `/api/v1/note/content/get` | ✓ | ✓ | ✓ | ✓ |
| `note.create` | 新建目录化笔记并初始化对应基元类型的起始文件 | `/api/v1/note/create` | ✓ | ✓ | ✓ | ✓ |
| `note.version.create` | 为笔记切出一个新的不可变目录版本快照，旧的留着 | `/api/v1/note/version/create` | ✓ | ✓ | ✓ | ✓ |
| `note.update` | 给笔记改标题、页面树位置或关联工单 | `/api/v1/note/update` | ✓ | ✓ |   |   |
| `note.delete` | 删掉一篇笔记 | `/api/v1/note/delete` | ✓ | ✓ |   |   |
| `note.previewDelete` | 试删一篇笔记：说会删掉什么，不真删 | `/api/v1/note/previewDelete` | ✓ | ✓ |   |   |
| `note.tree.move` | 在页面树中移动或重排笔记节点（自动校验环路） | `/api/v1/note/tree/move` | ✓ | ✓ | ✓ | ✓ |
| `note.link.list` | 列出笔记或工单的出站双向链接（[[note:...]] / [[issue:...]]）与反向链接 | `/api/v1/note/link/list` | ✓ | ✓ | ✓ | ✓ |
| `note.doc.view` | 读取块文档（Doc）的结构化内容块、字数、分页与外链投影 | `/api/v1/note/doc/view` | ✓ | ✓ | ✓ | ✓ |
| `note.doc.appendBlock` | 向块文档（Doc）追加一个结构化内容块并刷新双向链接索引 | `/api/v1/note/doc/appendBlock` | ✓ | ✓ | ✓ | ✓ |
| `note.base.view` | 读取多维库（Base）指定工作表与视图经过筛选、排序、分组和汇总后的投影 | `/api/v1/note/base/view` | ✓ | ✓ | ✓ | ✓ |
| `note.base.upsertRow` | 在多维库（Base）工作表中新增或更新一行数据 | `/api/v1/note/base/upsertRow` | ✓ | ✓ | ✓ | ✓ |
| `note.base.runAgentColumn` | 在多维库（Base）指定行上触发 Agent 动作列执行并回写结果或生成工单 | `/api/v1/note/base/runAgentColumn` | ✓ | ✓ | ✓ |   |
| `note.type.list` | 列出全部 4 类笔记基元（块文档、多维库、自由画布、媒体记录） | `/api/v1/note/type/list` | ✓ | ✓ | ✓ | ✓ |
| `note.type.read` | 读取一种笔记基元的规范或参考分册 | `/api/v1/note/type/read` | ✓ | ✓ | ✓ | ✓ |
| `note.file.list` | 列出笔记目录中的文件（manifest.json、structure/* 与 asset/*） | `/api/v1/note/file/list` | ✓ | ✓ | ✓ | ✓ |
| `note.file.get` | 按相对路径读取笔记目录中的一个文件（可指定历史版本快照） | `/api/v1/note/file/get` | ✓ | ✓ | ✓ | ✓ |
| `note.file.write` | 原子写入一个或多个文件到笔记目录的 structure/ 或 asset/，记录来源并同步协作状态 | `/api/v1/note/file/write` | ✓ | ✓ | ✓ | ✓ |
| `note.file.delete` | 删除笔记目录中 structure/ 或 asset/ 下的指定文件，记录来源并同步协作状态 | `/api/v1/note/file/delete` | ✓ | ✓ | ✓ | ✓ |
| `note.suggestion.list` | 列出笔记上的改写建议，没答的和答过的 | `/api/v1/note/suggestion/list` | ✓ | ✓ | ✓ | ✓ |
| `note.suggestion.create` | 对笔记目录中的文件或目标提出改写建议 | `/api/v1/note/suggestion/create` | ✓ | ✓ | ✓ | ✓ |
| `note.suggestion.accept` | 接受一条改写建议 | `/api/v1/note/suggestion/accept` | ✓ | ✓ |   |   |
| `note.suggestion.reject` | 拒绝一条改写建议 | `/api/v1/note/suggestion/reject` | ✓ | ✓ |   |   |
| `note.presence.update` | 更新实时在场状态（光标、选区、高亮区域或视口），仅驻留内存不落库 | `/api/v1/note/presence/update` | ✓ | ✓ | ✓ | ✓ |
| `note.history.list` | 列出笔记的协作提交时间线，最新的在前 | `/api/v1/note/history/list` | ✓ | ✓ |   |   |
| `note.history.preview` | 只读预览指定历史前沿上的笔记快照 | `/api/v1/note/history/preview` | ✓ | ✓ |   |   |
| `note.history.restore` | 把笔记恢复到指定历史前沿并记为一次新提交 | `/api/v1/note/history/restore` | ✓ | ✓ |   |   |
| `note.history.fork` | 从指定的历史前沿分叉出一篇新笔记 | `/api/v1/note/history/fork` | ✓ | ✓ |   |   |
| `note.history.undoOrigin` | 按提交来源选择性撤销某一轮的改动，保留其他人的并发编辑 | `/api/v1/note/history/undoOrigin` | ✓ | ✓ |   |   |
| `note.history.compact` | 把较早的操作历史压缩成浅快照，当前内容保持不变 | `/api/v1/note/history/compact` | ✓ | ✓ |   |   |
| `note.collab.export` | 按版本向量导出笔记的 Loro 增量同步更新或快照 | `/api/v1/note/collab/export` | ✓ | ✓ | ✓ | ✓ |
| `note.collab.import` | 导入端上的 Loro 增量更新并合入笔记目录，可选返回服务端缺失增量 | `/api/v1/note/collab/import` | ✓ | ✓ |   |   |
| `note.cover.set` | cap.op.note.cover.set | `/api/v1/note/cover/set` | ✓ | ✓ |   |   |

## game

里程碑和称号

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `game.shop.list` | 列出田头小摊里的庭院摆件和工单模板 | `/api/v1/game/shop/list` | ✓ | ✓ |   |   |
| `game.shop.buy` | 用金币买一件庭院摆件或工单模板 | `/api/v1/game/shop/buy` | ✓ | ✓ |   |   |
| `game.daily.list` | 列出今天的每日任务和自动结算金币 | `/api/v1/game/daily/list` | ✓ | ✓ |   |   |

## runtime

引擎：机器上的编码 agent

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `runtime.list` | 列出全部引擎 | `/api/v1/runtime/list` | ✓ | ✓ |   |   |
| `runtime.refresh` | 重新探测一个引擎 | `/api/v1/runtime/refresh` | ✓ | ✓ |   |   |
| `runtime.setting.update` | 改一个引擎的设置：开关、路径、默认模型、预算 | `/api/v1/runtime/setting/update` | ✓ |   |   |   |
| `runtime.mcp.list` | cap.op.runtime.mcp.list | `/api/v1/runtime/mcp/list` | ✓ | ✓ |   |   |
| `runtime.mcp.install` | cap.op.runtime.mcp.install | `/api/v1/runtime/mcp/install` | ✓ |   |   |   |
| `runtime.mcp.uninstall` | cap.op.runtime.mcp.uninstall | `/api/v1/runtime/mcp/uninstall` | ✓ |   |   |   |
| `runtime.mcpServer.list` | cap.op.runtime.mcpServer.list | `/api/v1/runtime/mcpServer/list` | ✓ | ✓ |   |   |
| `runtime.mcpServer.save` | cap.op.runtime.mcpServer.save | `/api/v1/runtime/mcpServer/save` | ✓ |   |   |   |
| `runtime.mcpServer.toggle` | cap.op.runtime.mcpServer.toggle | `/api/v1/runtime/mcpServer/toggle` | ✓ |   |   |   |
| `runtime.mcpServer.remove` | cap.op.runtime.mcpServer.remove | `/api/v1/runtime/mcpServer/remove` | ✓ |   |   |   |

## repo

仓库：工作区下的 git 仓库

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `repo.pr.submit` | 发布已有本地分支 | `/api/v1/repo/pr/submit` | ✓ |   |   |   |
| `repo.list` | 列出全部仓库 | `/api/v1/repo/list` | ✓ | ✓ | ✓ |   |
| `repo.validate` | 新建仓库会被拒的第一处，不真建 | `/api/v1/repo/validate` | ✓ | ✓ |   |   |
| `repo.create` | 新建一个仓库 | `/api/v1/repo/create` | ✓ | ✓ |   |   |
| `repo.mount` | cap.op.repo.mount | `/api/v1/repo/mount` | ✓ | ✓ |   |   |
| `repo.unmount` | cap.op.repo.unmount | `/api/v1/repo/unmount` | ✓ | ✓ |   |   |
| `repo.language.list` | 仓库用了哪些语言 | `/api/v1/repo/language/list` | ✓ | ✓ |   |   |
| `repo.template.list` | 仓库的任务模板，按它的栈填好 | `/api/v1/repo/template/list` | ✓ | ✓ |   |   |
| `repo.activity.get` | 仓库的提交：每天几次、谁提交的 | `/api/v1/repo/activity/get` | ✓ | ✓ |   |   |

## github

GitHub 的检测：gh 装没装、登没登录

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `github.get` | 看 gh 装没装、登没登录 | `/api/v1/github/get` | ✓ | ✓ |   |   |
| `github.refresh` | 重新检测 GitHub，顺带刷新开着的 PR | `/api/v1/github/refresh` | ✓ | ✓ |   |   |

## agent

角色：派活时指给谁

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `agent.list` | 列出全部角色 | `/api/v1/agent/list` | ✓ | ✓ |   |   |
| `agent.validate` | 看每份角色现在派活哪里不对，没存的草稿也看 | `/api/v1/agent/validate` | ✓ | ✓ |   |   |
| `agent.create` | 新建一份角色 | `/api/v1/agent/create` | ✓ |   |   |   |
| `agent.update` | 改一份角色（整份写入） | `/api/v1/agent/update` | ✓ |   |   |   |
| `agent.register` | 幂等登记或更新一个外部编程队友并分配稳定 W-XX 编号 | `/api/v1/agent/register` | ✓ | ✓ |   |   |
| `agent.delete` | 删掉一份角色 | `/api/v1/agent/delete` | ✓ |   |   |   |
| `agent.previewDelete` | 试删一份角色：说会删掉什么，不真删 | `/api/v1/agent/previewDelete` | ✓ |   |   |   |
| `agent.template.list` | 列出能装的角色模板：内置的，再是加进来的 | `/api/v1/agent/template/list` | ✓ | ✓ |   |   |
| `agent.template.install` | 从模板装一份新角色 | `/api/v1/agent/template/install` | ✓ |   |   |   |
| `agent.template.update` | 照模板现在的版本重做角色，本机的设置留着 | `/api/v1/agent/template/update` | ✓ |   |   |   |
| `agent.template.add` | 把本机的一个模板文件夹加进来，不装 | `/api/v1/agent/template/add` | ✓ |   |   |   |
| `agent.template.delete` | 删掉加进来的模板，从它装的角色留着 | `/api/v1/agent/template/delete` | ✓ |   |   |   |

## skill

技能

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `skill.list` | 列出全部技能 | `/api/v1/skill/list` | ✓ | ✓ |   |   |
| `skill.create` | 新建一个技能 | `/api/v1/skill/create` | ✓ |   |   |   |
| `skill.update` | 改一个技能 | `/api/v1/skill/update` | ✓ |   |   |   |
| `skill.delete` | 删掉一个技能 | `/api/v1/skill/delete` | ✓ |   |   |   |

## memory

角色的记忆

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `memory.list` | 列出一份角色的记忆：库里的和配置的来源 | `/api/v1/memory/list` | ✓ | ✓ |   |   |
| `memory.recall` | 看角色对这个仓库和这句话会想起什么 | `/api/v1/memory/recall` | ✓ | ✓ |   |   |
| `memory.create` | 给一份角色记一条记忆 | `/api/v1/memory/create` | ✓ | ✓ | ✓ | ✓ |
| `memory.search` | 按字搜记忆，不指定角色就搜全部 | `/api/v1/memory/search` | ✓ | ✓ | ✓ | ✓ |
| `memory.delete` | 删掉角色的一条记忆 | `/api/v1/memory/delete` | ✓ | ✓ |   |   |
| `memory.previewDelete` | 试删一条记忆：说会删掉什么，不真删 | `/api/v1/memory/previewDelete` | ✓ | ✓ |   |   |

## connector

连接器：把微信、飞书、QQ 接到频道

| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `connector.login` | 登录一个连接器 | `/api/v1/connector/login` | ✓ |   |   |   |
| `connector.verify` | 交验证码，接着连接器的登录 | `/api/v1/connector/verify` | ✓ |   |   |   |
| `connector.logout` | 退出一个连接器的登录 | `/api/v1/connector/logout` | ✓ |   |   |   |
| `connector.channel.set` | 设连接器的消息进哪个频道 | `/api/v1/connector/channel/set` | ✓ |   |   |   |

## attachment



| 操作 | 做什么 | 路径（POST） | 用户 | 连进来的设备 | 主助手 | 执行会话 |
|---|---|---|---|---|---|---|
| `attachment.create` | 上传一个文件，给消息带上或放进媒体库 | `/api/v1/attachment/create` | ✓ | ✓ |   |   |
| `attachment.importPath` | 将本机常规文件直接导入附件存储（仅本机用户） | `/api/v1/attachment/importPath` | ✓ |   |   |   |
