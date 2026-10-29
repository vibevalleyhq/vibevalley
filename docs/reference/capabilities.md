# 能力表

由 `scripts/capabilities.ts` 从 `packages/protocol/src/api.ts` 的 `endpoints`（每个接口的 `can`）写出，不手改；`vp run docs:verify` 查它是不是最新。为什么这样分见 [先有能力，再有入口](docs/subsystems/core.md)。

| 谁 | 是谁 | 从哪个入口 |
|---|---|---|
| 主人 | 主人在农场那台电脑上 | 页面、命令行 |
| 连进来的设备 | 主人配对过的手机、另一台电脑 | 经「连接到本机」只放这一列打了 ✓ 的 |
| 管家 | 管家 | 它的工具：打了 ✓ 的每个接口是它的一个工具（`channel.message.list` 是 `channel_message_list`），`apps/server/src/tool` 照这一列给 |
| 帮工 | 在干活的执行 | 经 `/mcp` 拿的工具，同上 |

`GET /api/v1/state`、`GET /api/v1/events` 和 `GET /api/v1/live` 是 SSE，不在 `endpoints` 里：主人和连进来的设备都能读；`/state` 给折好的帧，`/live` 只给页面要的三种 side event，`/events` 留给命令行和调试。接口都在 `/api/v1` 下；不兼容改动和 v1 的保留见 [接口版本](docs/subsystems/core.md#为什么这样)。

## server

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `server.health.get` | `/api/v1/server/health/get` | ✓ | ✓ |   |   |

## orchestrator

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `orchestrator.open` | `/api/v1/orchestrator/open` | ✓ | ✓ |   |   |
| `orchestrator.stop` | `/api/v1/orchestrator/stop` | ✓ | ✓ |   |   |
| `orchestrator.archive.list` | `/api/v1/orchestrator/archive/list` | ✓ | ✓ |   |   |
| `orchestrator.archive.get` | `/api/v1/orchestrator/archive/get` | ✓ | ✓ |   |   |
| `orchestrator.eval.create` | `/api/v1/orchestrator/eval/create` | ✓ | ✓ |   |   |

## setting

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `setting.get` | `/api/v1/setting/get` | ✓ | ✓ |   |   |
| `setting.validate` | `/api/v1/setting/validate` | ✓ | ✓ |   |   |
| `setting.update` | `/api/v1/setting/update` | ✓ |   |   |   |

## channel

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `channel.message.send` | `/api/v1/channel/message/send` | ✓ | ✓ |   | ✓ |
| `channel.create` | `/api/v1/channel/create` | ✓ | ✓ | ✓ |   |
| `channel.update` | `/api/v1/channel/update` | ✓ | ✓ | ✓ |   |
| `channel.default.set` | `/api/v1/channel/default/set` | ✓ | ✓ |   |   |
| `channel.message.list` | `/api/v1/channel/message/list` | ✓ | ✓ | ✓ | ✓ |
| `channel.markRead` | `/api/v1/channel/markRead` | ✓ | ✓ |   |   |
| `channel.message.update` | `/api/v1/channel/message/update` | ✓ | ✓ |   |   |
| `channel.message.delete` | `/api/v1/channel/message/delete` | ✓ | ✓ |   |   |
| `channel.message.previewDelete` | `/api/v1/channel/message/previewDelete` | ✓ | ✓ |   |   |
| `channel.message.search` | `/api/v1/channel/message/search` | ✓ | ✓ |   |   |
| `channel.reaction.toggle` | `/api/v1/channel/reaction/toggle` | ✓ | ✓ |   |   |
| `channel.pin.toggle` | `/api/v1/channel/pin/toggle` | ✓ | ✓ |   |   |
| `channel.pin.list` | `/api/v1/channel/pin/list` | ✓ | ✓ |   |   |
| `channel.thread.create` | `/api/v1/channel/thread/create` | ✓ | ✓ |   |   |
| `channel.archive.toggle` | `/api/v1/channel/archive/toggle` | ✓ | ✓ |   |   |
| `channel.delete` | `/api/v1/channel/delete` | ✓ | ✓ |   |   |
| `channel.previewDelete` | `/api/v1/channel/previewDelete` | ✓ | ✓ |   |   |
| `channel.direct.create` | `/api/v1/channel/direct/create` | ✓ | ✓ |   |   |
| `channel.notify.set` | `/api/v1/channel/notify/set` | ✓ | ✓ |   |   |
| `channel.markUnread` | `/api/v1/channel/markUnread` | ✓ | ✓ |   |   |
| `channel.list` | `/api/v1/channel/list` | ✓ | ✓ | ✓ |   |
| `channel.unread.list` | `/api/v1/channel/unread/list` | ✓ | ✓ |   | ✓ |
| `channel.attachment.create` | `/api/v1/channel/attachment/create` | ✓ | ✓ |   |   |

## cron

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `cron.create` | `/api/v1/cron/create` | ✓ | ✓ | ✓ |   |
| `cron.list` | `/api/v1/cron/list` | ✓ | ✓ | ✓ |   |
| `cron.update` | `/api/v1/cron/update` | ✓ | ✓ |   |   |
| `cron.delete` | `/api/v1/cron/delete` | ✓ | ✓ | ✓ |   |
| `cron.previewDelete` | `/api/v1/cron/previewDelete` | ✓ | ✓ | ✓ |   |

## voice

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `voice.hear` | `/api/v1/voice/hear` | ✓ | ✓ |   |   |
| `voice.moss.verify` | `/api/v1/voice/moss/verify` | ✓ | ✓ |   |   |
| `voice.grant.create` | `/api/v1/voice/grant/create` | ✓ | ✓ |   |   |
| `voice.grant.renew` | `/api/v1/voice/grant/renew` | ✓ | ✓ |   |   |
| `voice.call.start` | `/api/v1/voice/call/start` | ✓ | ✓ |   |   |
| `voice.call.stop` | `/api/v1/voice/call/stop` | ✓ | ✓ |   |   |
| `voice.call.hear` | `/api/v1/voice/call/hear` | ✓ | ✓ |   |   |
| `voice.call.say` | `/api/v1/voice/call/say` | ✓ | ✓ |   |   |
| `voice.dictate` | `/api/v1/voice/dictate` | ✓ | ✓ |   |   |

## issue

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `issue.comment.create` | `/api/v1/issue/comment/create` | ✓ | ✓ | ✓ |   |
| `issue.diff.get` | `/api/v1/issue/diff/get` | ✓ | ✓ | ✓ |   |
| `issue.history.list` | `/api/v1/issue/history/list` | ✓ | ✓ |   |   |
| `issue.list` | `/api/v1/issue/list` | ✓ | ✓ | ✓ |   |
| `issue.review` | `/api/v1/issue/review` | ✓ | ✓ | ✓ |   |
| `issue.split` | `/api/v1/issue/split` | ✓ | ✓ |   | ✓ |
| `issue.get` | `/api/v1/issue/get` | ✓ | ✓ | ✓ |   |
| `issue.run.list` | `/api/v1/issue/run/list` | ✓ | ✓ |   |   |
| `issue.timeline.get` | `/api/v1/issue/timeline/get` | ✓ | ✓ |   |   |
| `issue.create` | `/api/v1/issue/create` | ✓ | ✓ | ✓ |   |
| `issue.update` | `/api/v1/issue/update` | ✓ | ✓ | ✓ |   |
| `issue.delete` | `/api/v1/issue/delete` | ✓ | ✓ |   |   |
| `issue.previewDelete` | `/api/v1/issue/previewDelete` | ✓ | ✓ |   |   |
| `issue.status.update` | `/api/v1/issue/status/update` | ✓ | ✓ | ✓ |   |
| `issue.status.previewUpdate` | `/api/v1/issue/status/previewUpdate` | ✓ | ✓ | ✓ |   |
| `issue.refine` | `/api/v1/issue/refine` | ✓ | ✓ |   |   |

## session

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `session.stop` | `/api/v1/session/stop` | ✓ | ✓ | ✓ |   |
| `session.list` | `/api/v1/session/list` | ✓ | ✓ | ✓ | ✓ |
| `session.get` | `/api/v1/session/get` | ✓ | ✓ |   |   |
| `session.event.list` | `/api/v1/session/event/list` | ✓ | ✓ |   |   |

## graph

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `graph.split` | `/api/v1/graph/split` | ✓ | ✓ | ✓ |   |
| `graph.task.update` | `/api/v1/graph/task/update` | ✓ | ✓ | ✓ |   |
| `graph.task.delete` | `/api/v1/graph/task/delete` | ✓ | ✓ | ✓ |   |
| `graph.task.previewDelete` | `/api/v1/graph/task/previewDelete` | ✓ | ✓ | ✓ |   |
| `graph.act` | `/api/v1/graph/act` | ✓ | ✓ | ✓ |   |
| `graph.task.act` | `/api/v1/graph/task/act` | ✓ | ✓ | ✓ |   |
| `graph.diff.get` | `/api/v1/graph/diff/get` | ✓ | ✓ |   |   |
| `graph.event.list` | `/api/v1/graph/event/list` | ✓ | ✓ |   |   |
| `graph.list` | `/api/v1/graph/list` | ✓ | ✓ | ✓ |   |
| `graph.get` | `/api/v1/graph/get` | ✓ | ✓ | ✓ |   |

## artifact

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `artifact.list` | `/api/v1/artifact/list` | ✓ | ✓ | ✓ | ✓ |
| `artifact.get` | `/api/v1/artifact/get` | ✓ | ✓ | ✓ | ✓ |
| `artifact.content.get` | `/api/v1/artifact/content/get` | ✓ | ✓ | ✓ | ✓ |
| `artifact.create` | `/api/v1/artifact/create` | ✓ | ✓ | ✓ | ✓ |
| `artifact.version.create` | `/api/v1/artifact/version/create` | ✓ | ✓ | ✓ | ✓ |
| `artifact.update` | `/api/v1/artifact/update` | ✓ | ✓ |   |   |
| `artifact.delete` | `/api/v1/artifact/delete` | ✓ | ✓ |   |   |
| `artifact.previewDelete` | `/api/v1/artifact/previewDelete` | ✓ | ✓ |   |   |
| `artifact.block.list` | `/api/v1/artifact/block/list` | ✓ | ✓ |   |   |
| `artifact.submit` | `/api/v1/artifact/submit` | ✓ | ✓ |   |   |
| `artifact.block.create` | `/api/v1/artifact/block/create` | ✓ | ✓ |   | ✓ |
| `artifact.block.update` | `/api/v1/artifact/block/update` | ✓ | ✓ |   | ✓ |
| `artifact.markdown.get` | `/api/v1/artifact/markdown/get` | ✓ | ✓ |   |   |
| `artifact.demo` | `/api/v1/artifact/demo` | ✓ |   |   |   |

## game

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `game.achievement.list` | `/api/v1/game/achievement/list` | ✓ | ✓ |   |   |
| `game.title.set` | `/api/v1/game/title/set` | ✓ | ✓ |   |   |

## runtime

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `runtime.list` | `/api/v1/runtime/list` | ✓ | ✓ |   |   |
| `runtime.refresh` | `/api/v1/runtime/refresh` | ✓ | ✓ |   |   |
| `runtime.setting.update` | `/api/v1/runtime/setting/update` | ✓ |   |   |   |

## github

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `github.get` | `/api/v1/github/get` | ✓ | ✓ |   |   |
| `github.refresh` | `/api/v1/github/refresh` | ✓ | ✓ |   |   |

## agent

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `agent.list` | `/api/v1/agent/list` | ✓ | ✓ |   |   |
| `agent.validate` | `/api/v1/agent/validate` | ✓ | ✓ |   |   |
| `agent.create` | `/api/v1/agent/create` | ✓ |   |   |   |
| `agent.update` | `/api/v1/agent/update` | ✓ |   |   |   |
| `agent.delete` | `/api/v1/agent/delete` | ✓ |   |   |   |
| `agent.previewDelete` | `/api/v1/agent/previewDelete` | ✓ |   |   |   |
| `agent.template.list` | `/api/v1/agent/template/list` | ✓ | ✓ |   |   |
| `agent.template.install` | `/api/v1/agent/template/install` | ✓ |   |   |   |
| `agent.template.update` | `/api/v1/agent/template/update` | ✓ |   |   |   |
| `agent.template.add` | `/api/v1/agent/template/add` | ✓ |   |   |   |
| `agent.template.delete` | `/api/v1/agent/template/delete` | ✓ |   |   |   |
| `agent.template.previewDelete` | `/api/v1/agent/template/previewDelete` | ✓ |   |   |   |

## memory

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `memory.list` | `/api/v1/memory/list` | ✓ | ✓ |   |   |
| `memory.recall` | `/api/v1/memory/recall` | ✓ | ✓ |   |   |
| `memory.create` | `/api/v1/memory/create` | ✓ | ✓ | ✓ | ✓ |
| `memory.search` | `/api/v1/memory/search` | ✓ | ✓ | ✓ | ✓ |
| `memory.delete` | `/api/v1/memory/delete` | ✓ | ✓ |   |   |
| `memory.previewDelete` | `/api/v1/memory/previewDelete` | ✓ | ✓ |   |   |

## skill

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `skill.list` | `/api/v1/skill/list` | ✓ | ✓ |   |   |
| `skill.create` | `/api/v1/skill/create` | ✓ |   |   |   |
| `skill.update` | `/api/v1/skill/update` | ✓ |   |   |   |
| `skill.delete` | `/api/v1/skill/delete` | ✓ |   |   |   |
| `skill.previewDelete` | `/api/v1/skill/previewDelete` | ✓ |   |   |   |

## project

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `project.list` | `/api/v1/project/list` | ✓ | ✓ | ✓ |   |
| `project.validate` | `/api/v1/project/validate` | ✓ | ✓ |   |   |
| `project.create` | `/api/v1/project/create` | ✓ | ✓ |   |   |
| `project.language.list` | `/api/v1/project/language/list` | ✓ | ✓ |   |   |
| `project.template.list` | `/api/v1/project/template/list` | ✓ | ✓ |   |   |
| `project.activity.get` | `/api/v1/project/activity/get` | ✓ | ✓ |   |   |

## connector

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `connector.list` | `/api/v1/connector/list` | ✓ | ✓ |   |   |
| `connector.login` | `/api/v1/connector/login` | ✓ |   |   |   |
| `connector.verify` | `/api/v1/connector/verify` | ✓ |   |   |   |
| `connector.logout` | `/api/v1/connector/logout` | ✓ |   |   |   |
| `connector.channel.set` | `/api/v1/connector/channel/set` | ✓ |   |   |   |

## lan

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 | 帮工 |
|---|---|---|---|---|---|
| `lan.get` | `/api/v1/lan/get` | ✓ |   |   |   |
| `lan.update` | `/api/v1/lan/update` | ✓ |   |   |   |
| `lan.pairing.start` | `/api/v1/lan/pairing/start` | ✓ |   |   |   |
| `lan.pairing.stop` | `/api/v1/lan/pairing/stop` | ✓ |   |   |   |
| `lan.pairing.previewStop` | `/api/v1/lan/pairing/previewStop` | ✓ |   |   |   |
| `lan.pairing.answer` | `/api/v1/lan/pairing/answer` | ✓ |   |   |   |
| `lan.device.delete` | `/api/v1/lan/device/delete` | ✓ |   |   |   |
| `lan.device.previewDelete` | `/api/v1/lan/device/previewDelete` | ✓ |   |   |   |
| `lan.pair` | `/api/v1/lan/pair` | ✓ | ✓ |   |   |
| `lan.me.get` | `/api/v1/lan/me/get` | ✓ | ✓ |   |   |
