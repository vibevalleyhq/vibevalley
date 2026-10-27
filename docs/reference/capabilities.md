# 能力表

由 `scripts/capabilities.ts` 从 `packages/protocol/src/api.ts` 的 `endpoints`（每个接口的 `can`）写出，不手改；`vp run docs:verify` 查它是不是最新。为什么这样分见 [先有能力，再有入口](docs/subsystems/core.md)。

| 谁 | 是谁 | 从哪个入口 |
|---|---|---|
| 主人 | 主人在农场那台电脑上 | 页面、命令行 |
| 连进来的设备 | 主人配对过的手机、另一台电脑 | 经「连接到本机」只放这一列打了 ✓ 的 |
| 管家 | 管家 | 只是记下，不按它放行：管家的工具另写在 `apps/server/src/tool` |

帮工没有接口：它们经 `/mcp` 用 `apps/server/src/tool` 的工具。

`GET /api/v1/state`、`GET /api/v1/events` 和 `GET /api/v1/live` 是 SSE，不在 `endpoints` 里：主人和连进来的设备都能读；`/state` 给折好的帧，`/live` 只给页面要的三种 side event，`/events` 留给命令行和调试。接口都在 `/api/v1` 下；不兼容改动和 v1 的保留见 [接口版本](docs/subsystems/core.md#为什么这样)。

## server

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `server.health.get` | `/api/v1/server/health/get` | ✓ | ✓ |   |

## orchestrator

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `orchestrator.open` | `/api/v1/orchestrator/open` | ✓ | ✓ |   |
| `orchestrator.stop` | `/api/v1/orchestrator/stop` | ✓ | ✓ |   |
| `orchestrator.archive.list` | `/api/v1/orchestrator/archive/list` | ✓ | ✓ | ✓ |
| `orchestrator.archive.get` | `/api/v1/orchestrator/archive/get` | ✓ | ✓ |   |
| `orchestrator.eval.create` | `/api/v1/orchestrator/eval/create` | ✓ | ✓ |   |

## setting

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `setting.get` | `/api/v1/setting/get` | ✓ | ✓ |   |
| `setting.check` | `/api/v1/setting/check` | ✓ | ✓ |   |
| `setting.update` | `/api/v1/setting/update` | ✓ |   |   |

## channel

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `channel.message.send` | `/api/v1/channel/message/send` | ✓ | ✓ |   |
| `channel.create` | `/api/v1/channel/create` | ✓ | ✓ | ✓ |
| `channel.update` | `/api/v1/channel/update` | ✓ | ✓ | ✓ |
| `channel.message.list` | `/api/v1/channel/message/list` | ✓ | ✓ | ✓ |
| `channel.markRead` | `/api/v1/channel/markRead` | ✓ | ✓ |   |

## recurrence

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `recurrence.create` | `/api/v1/recurrence/create` | ✓ | ✓ | ✓ |
| `recurrence.list` | `/api/v1/recurrence/list` | ✓ | ✓ | ✓ |
| `recurrence.update` | `/api/v1/recurrence/update` | ✓ | ✓ |   |
| `recurrence.delete` | `/api/v1/recurrence/delete` | ✓ | ✓ | ✓ |
| `recurrence.previewDelete` | `/api/v1/recurrence/previewDelete` | ✓ | ✓ | ✓ |

## voice

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `voice.hear` | `/api/v1/voice/hear` | ✓ | ✓ |   |
| `voice.session.create` | `/api/v1/voice/session/create` | ✓ | ✓ |   |
| `voice.session.renew` | `/api/v1/voice/session/renew` | ✓ | ✓ |   |
| `voice.agent.start` | `/api/v1/voice/agent/start` | ✓ | ✓ |   |
| `voice.agent.stop` | `/api/v1/voice/agent/stop` | ✓ | ✓ |   |
| `voice.agent.hear` | `/api/v1/voice/agent/hear` | ✓ | ✓ |   |
| `voice.agent.say` | `/api/v1/voice/agent/say` | ✓ | ✓ |   |
| `voice.dictate` | `/api/v1/voice/dictate` | ✓ | ✓ |   |

## issue

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `issue.comment.create` | `/api/v1/issue/comment/create` | ✓ | ✓ | ✓ |
| `issue.diff.get` | `/api/v1/issue/diff/get` | ✓ | ✓ | ✓ |
| `issue.history.list` | `/api/v1/issue/history/list` | ✓ | ✓ | ✓ |
| `issue.list` | `/api/v1/issue/list` | ✓ | ✓ |   |
| `issue.get` | `/api/v1/issue/get` | ✓ | ✓ |   |
| `issue.run.list` | `/api/v1/issue/run/list` | ✓ | ✓ |   |
| `issue.timeline.get` | `/api/v1/issue/timeline/get` | ✓ | ✓ |   |
| `issue.create` | `/api/v1/issue/create` | ✓ | ✓ |   |
| `issue.update` | `/api/v1/issue/update` | ✓ | ✓ |   |
| `issue.delete` | `/api/v1/issue/delete` | ✓ | ✓ |   |
| `issue.previewDelete` | `/api/v1/issue/previewDelete` | ✓ | ✓ |   |
| `issue.move` | `/api/v1/issue/move` | ✓ | ✓ |   |
| `issue.status.update` | `/api/v1/issue/status/update` | ✓ | ✓ |   |
| `issue.status.previewUpdate` | `/api/v1/issue/status/previewUpdate` | ✓ | ✓ |   |
| `issue.refine` | `/api/v1/issue/refine` | ✓ | ✓ |   |
| `issue.dispatch` | `/api/v1/issue/dispatch` | ✓ | ✓ |   |
| `issue.act` | `/api/v1/issue/act` | ✓ | ✓ |   |
| `issue.previewAct` | `/api/v1/issue/previewAct` | ✓ | ✓ |   |

## session

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `session.stop` | `/api/v1/session/stop` | ✓ | ✓ | ✓ |
| `session.list` | `/api/v1/session/list` | ✓ | ✓ |   |
| `session.get` | `/api/v1/session/get` | ✓ | ✓ |   |
| `session.event.list` | `/api/v1/session/event/list` | ✓ | ✓ |   |

## graph

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `graph.split` | `/api/v1/graph/split` | ✓ | ✓ | ✓ |
| `graph.task.update` | `/api/v1/graph/task/update` | ✓ | ✓ | ✓ |
| `graph.task.delete` | `/api/v1/graph/task/delete` | ✓ | ✓ | ✓ |
| `graph.task.previewDelete` | `/api/v1/graph/task/previewDelete` | ✓ | ✓ | ✓ |
| `graph.act` | `/api/v1/graph/act` | ✓ | ✓ | ✓ |
| `graph.task.act` | `/api/v1/graph/task/act` | ✓ | ✓ | ✓ |
| `graph.diff.get` | `/api/v1/graph/diff/get` | ✓ | ✓ |   |
| `graph.event.list` | `/api/v1/graph/event/list` | ✓ | ✓ |   |

## game

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `game.achievement.list` | `/api/v1/game/achievement/list` | ✓ | ✓ |   |
| `game.title.set` | `/api/v1/game/title/set` | ✓ | ✓ |   |

## runtime

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `runtime.list` | `/api/v1/runtime/list` | ✓ | ✓ |   |
| `runtime.refresh` | `/api/v1/runtime/refresh` | ✓ | ✓ |   |
| `runtime.setting.update` | `/api/v1/runtime/setting/update` | ✓ |   |   |

## github

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `github.get` | `/api/v1/github/get` | ✓ | ✓ |   |
| `github.refresh` | `/api/v1/github/refresh` | ✓ | ✓ |   |

## agent

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `agent.list` | `/api/v1/agent/list` | ✓ | ✓ |   |
| `agent.check` | `/api/v1/agent/check` | ✓ | ✓ |   |
| `agent.create` | `/api/v1/agent/create` | ✓ |   | ✓ |
| `agent.update` | `/api/v1/agent/update` | ✓ |   |   |
| `agent.delete` | `/api/v1/agent/delete` | ✓ |   |   |
| `agent.previewDelete` | `/api/v1/agent/previewDelete` | ✓ |   |   |

## memory

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `memory.list` | `/api/v1/memory/list` | ✓ | ✓ |   |
| `memory.recall` | `/api/v1/memory/recall` | ✓ | ✓ |   |
| `memory.create` | `/api/v1/memory/create` | ✓ | ✓ | ✓ |
| `memory.delete` | `/api/v1/memory/delete` | ✓ | ✓ |   |
| `memory.previewDelete` | `/api/v1/memory/previewDelete` | ✓ | ✓ |   |

## skill

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `skill.list` | `/api/v1/skill/list` | ✓ | ✓ |   |
| `skill.create` | `/api/v1/skill/create` | ✓ |   | ✓ |
| `skill.update` | `/api/v1/skill/update` | ✓ |   |   |
| `skill.delete` | `/api/v1/skill/delete` | ✓ |   |   |
| `skill.previewDelete` | `/api/v1/skill/previewDelete` | ✓ |   |   |

## project

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `project.list` | `/api/v1/project/list` | ✓ | ✓ | ✓ |
| `project.check` | `/api/v1/project/check` | ✓ | ✓ |   |
| `project.create` | `/api/v1/project/create` | ✓ | ✓ |   |
| `project.language.list` | `/api/v1/project/language/list` | ✓ | ✓ |   |
| `project.template.list` | `/api/v1/project/template/list` | ✓ | ✓ |   |
| `project.activity.get` | `/api/v1/project/activity/get` | ✓ | ✓ |   |

## connector

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `connector.list` | `/api/v1/connector/list` | ✓ | ✓ |   |
| `connector.login` | `/api/v1/connector/login` | ✓ |   |   |
| `connector.verify` | `/api/v1/connector/verify` | ✓ |   |   |
| `connector.logout` | `/api/v1/connector/logout` | ✓ |   |   |
| `connector.channel.set` | `/api/v1/connector/channel/set` | ✓ |   |   |

## lan

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `lan.get` | `/api/v1/lan/get` | ✓ |   |   |
| `lan.update` | `/api/v1/lan/update` | ✓ |   |   |
| `lan.pairing.start` | `/api/v1/lan/pairing/start` | ✓ |   |   |
| `lan.pairing.stop` | `/api/v1/lan/pairing/stop` | ✓ |   |   |
| `lan.pairing.previewStop` | `/api/v1/lan/pairing/previewStop` | ✓ |   |   |
| `lan.pairing.answer` | `/api/v1/lan/pairing/answer` | ✓ |   |   |
| `lan.device.delete` | `/api/v1/lan/device/delete` | ✓ |   |   |
| `lan.device.previewDelete` | `/api/v1/lan/device/previewDelete` | ✓ |   |   |
| `lan.pair` | `/api/v1/lan/pair` | ✓ | ✓ |   |
| `lan.me.get` | `/api/v1/lan/me/get` | ✓ | ✓ |   |

## doc

| 操作 | 路径（POST） | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `doc.list` | `/api/v1/doc/list` | ✓ | ✓ |   |
| `doc.create` | `/api/v1/doc/create` | ✓ | ✓ |   |
| `doc.import` | `/api/v1/doc/import` | ✓ | ✓ |   |
| `doc.get` | `/api/v1/doc/get` | ✓ | ✓ |   |
| `doc.submit` | `/api/v1/doc/submit` | ✓ | ✓ |   |
| `doc.markdown.get` | `/api/v1/doc/markdown/get` | ✓ | ✓ |   |
| `doc.demo` | `/api/v1/doc/demo` | ✓ |   |   |
