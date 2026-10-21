# 能力表

由 `scripts/capabilities.ts` 从 `packages/protocol/src/api.ts` 的 `endpoints`（每个接口的 `can`）写出，不手改；`bun run docs:verify` 查它是不是最新。为什么这样分见 [先有能力，再有入口](docs/subsystems/core.md)。

| 谁 | 是谁 | 从哪个入口 |
|---|---|---|
| 主人 | 主人在农场那台电脑上 | 页面、命令行 |
| 连进来的设备 | 主人配对过的手机、另一台电脑 | 经「连接到本机」只放这一列打了 ✓ 的 |
| 管家 | 管家 | 只是记下，不按它放行：管家的工具另写在 `apps/server/src/tool` |

帮工没有接口：它们经 `/mcp` 用 `apps/server/src/tool` 的工具。

`GET /api/v1/state`、`GET /api/v1/events` 和 `GET /api/v1/live` 是 SSE，不在 `endpoints` 里：主人和连进来的设备都能读；`/state` 给折好的帧，`/live` 只给页面要的三种 side event，`/events` 留给命令行和调试。接口都在 `/api/v1` 下；换成不兼容的形状时另起 `/api/v2`，`v1` 留到设备都升级（[理由](docs/subsystems/core.md)）。

## server

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `server.health` | `GET /api/v1/health` | ✓ | ✓ |   |

## manager

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `manager.open` | `POST /api/v1/manager/open` | ✓ | ✓ |   |
| `manager.stop` | `POST /api/v1/manager/stop` | ✓ | ✓ |   |
| `manager.hear` | `POST /api/v1/manager/hear` | ✓ | ✓ |   |
| `manager.listArchive` | `GET /api/v1/manager/archive` | ✓ | ✓ | ✓ |
| `manager.getArchive` | `GET /api/v1/manager/archive/{name}` | ✓ | ✓ |   |
| `manager.markWrong` | `POST /api/v1/manager/evals` | ✓ | ✓ |   |

## setting

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `setting.load` | `GET /api/v1/settings` | ✓ | ✓ |   |
| `setting.check` | `POST /api/v1/settings/check` | ✓ | ✓ |   |
| `setting.save` | `PUT /api/v1/settings` | ✓ |   |   |

## channel

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `channel.say` | `POST /api/v1/say` | ✓ | ✓ |   |
| `channel.create` | `POST /api/v1/channels` | ✓ | ✓ | ✓ |
| `channel.update` | `PUT /api/v1/channels/{id}` | ✓ | ✓ | ✓ |
| `channel.history` | `GET /api/v1/channels/{id}/messages` | ✓ | ✓ | ✓ |
| `channel.markRead` | `POST /api/v1/channels/{id}/read` | ✓ | ✓ |   |

## schedule

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `schedule.create` | `POST /api/v1/schedules` | ✓ | ✓ | ✓ |
| `schedule.list` | `GET /api/v1/schedules` | ✓ | ✓ | ✓ |
| `schedule.update` | `PUT /api/v1/schedules/{id}` | ✓ | ✓ |   |
| `schedule.delete` | `DELETE /api/v1/schedules/{id}` | ✓ | ✓ | ✓ |

## issue

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `issue.comment` | `POST /api/v1/issues/{id}/comment` | ✓ | ✓ | ✓ |
| `issue.changes` | `GET /api/v1/issues/{id}/changes` | ✓ | ✓ | ✓ |
| `issue.resolve` | `POST /api/v1/issues/{id}/resolve` | ✓ | ✓ |   |
| `issue.history` | `GET /api/v1/issues/history` | ✓ | ✓ | ✓ |
| `issue.list` | `GET /api/v1/issues` | ✓ | ✓ |   |
| `issue.get` | `GET /api/v1/issues/{id}` | ✓ | ✓ |   |
| `issue.runs` | `GET /api/v1/issues/{id}/runs` | ✓ | ✓ |   |
| `issue.create` | `POST /api/v1/issues` | ✓ | ✓ |   |
| `issue.update` | `PUT /api/v1/issues/{id}` | ✓ | ✓ |   |
| `issue.delete` | `DELETE /api/v1/issues/{id}` | ✓ | ✓ |   |
| `issue.move` | `PUT /api/v1/issues/{id}/move` | ✓ | ✓ |   |
| `issue.status` | `PUT /api/v1/issues/{id}/status` | ✓ | ✓ |   |
| `issue.draft` | `POST /api/v1/issues/{id}/draft` | ✓ | ✓ |   |
| `issue.dispatch` | `POST /api/v1/issues/{id}/dispatch` | ✓ | ✓ |   |
| `issue.accept` | `POST /api/v1/issues/{id}/accept` | ✓ | ✓ | ✓ |

## session

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `session.stop` | `POST /api/v1/sessions/{id}/stop` | ✓ | ✓ | ✓ |
| `session.list` | `GET /api/v1/sessions` | ✓ | ✓ |   |
| `session.get` | `GET /api/v1/sessions/{id}` | ✓ | ✓ |   |
| `session.events` | `GET /api/v1/sessions/{id}/events` | ✓ | ✓ |   |

## graph

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `graph.split` | `POST /api/v1/graphs` | ✓ | ✓ | ✓ |
| `graph.updateTask` | `PUT /api/v1/graphs/{id}/tasks/{task}` | ✓ | ✓ | ✓ |
| `graph.deleteTask` | `DELETE /api/v1/graphs/{id}/tasks/{task}` | ✓ | ✓ | ✓ |
| `graph.act` | `POST /api/v1/graphs/{id}/act` | ✓ | ✓ | ✓ |
| `graph.taskAct` | `POST /api/v1/graphs/{id}/tasks/{task}/act` | ✓ | ✓ | ✓ |
| `graph.changes` | `GET /api/v1/graphs/{id}/changes` | ✓ | ✓ |   |
| `graph.events` | `GET /api/v1/graphs/{id}/events` | ✓ | ✓ |   |

## game

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `game.achievements` | `GET /api/v1/game/achievements` | ✓ | ✓ |   |
| `game.chooseTitle` | `POST /api/v1/game/title` | ✓ | ✓ |   |

## runtime

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `runtime.list` | `GET /api/v1/runtimes` | ✓ | ✓ |   |
| `runtime.refresh` | `POST /api/v1/runtimes/{id}/refresh` | ✓ | ✓ |   |
| `runtime.update` | `PUT /api/v1/runtimes/{id}/settings` | ✓ |   |   |

## github

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `github.status` | `GET /api/v1/github` | ✓ | ✓ |   |
| `github.refresh` | `POST /api/v1/github/refresh` | ✓ | ✓ |   |

## agent

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `agent.list` | `GET /api/v1/agents` | ✓ | ✓ |   |
| `agent.check` | `POST /api/v1/agents/check` | ✓ | ✓ |   |
| `agent.create` | `POST /api/v1/agents` | ✓ |   | ✓ |
| `agent.save` | `PUT /api/v1/agents/{id}` | ✓ |   |   |
| `agent.delete` | `DELETE /api/v1/agents/{id}` | ✓ |   |   |

## memory

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `memory.list` | `GET /api/v1/memories/{agent}` | ✓ | ✓ |   |
| `memory.recall` | `GET /api/v1/memories/{agent}/recall` | ✓ | ✓ |   |
| `memory.create` | `POST /api/v1/memories/{agent}` | ✓ | ✓ | ✓ |
| `memory.delete` | `DELETE /api/v1/memories/{agent}/{memory}` | ✓ | ✓ |   |

## skill

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `skill.list` | `GET /api/v1/skills` | ✓ | ✓ |   |
| `skill.create` | `POST /api/v1/skills` | ✓ |   | ✓ |
| `skill.save` | `PUT /api/v1/skills/{id}` | ✓ |   |   |
| `skill.delete` | `DELETE /api/v1/skills/{id}` | ✓ |   |   |

## project

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `project.list` | `GET /api/v1/projects` | ✓ | ✓ | ✓ |
| `project.check` | `POST /api/v1/projects/check` | ✓ | ✓ |   |
| `project.create` | `POST /api/v1/projects` | ✓ | ✓ |   |
| `project.languages` | `GET /api/v1/projects/{id}/languages` | ✓ | ✓ |   |
| `project.templates` | `GET /api/v1/projects/{id}/templates` | ✓ | ✓ |   |
| `project.activity` | `GET /api/v1/projects/{id}/activity` | ✓ | ✓ |   |

## voice

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `voice.session` | `POST /api/v1/voice/session` | ✓ | ✓ |   |
| `voice.renew` | `POST /api/v1/voice/renew` | ✓ | ✓ |   |
| `voice.start` | `POST /api/v1/voice/agent` | ✓ | ✓ |   |
| `voice.stop` | `POST /api/v1/voice/agent/stop` | ✓ | ✓ |   |
| `voice.heard` | `POST /api/v1/voice/agent/heard` | ✓ | ✓ |   |
| `voice.said` | `POST /api/v1/voice/agent/said` | ✓ | ✓ |   |
| `voice.dictate` | `POST /api/v1/voice/dictate` | ✓ | ✓ |   |

## connector

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `connector.list` | `GET /api/v1/connectors` | ✓ | ✓ |   |
| `connector.login` | `POST /api/v1/connectors/{id}/login` | ✓ |   |   |
| `connector.verify` | `POST /api/v1/connectors/{id}/verify` | ✓ |   |   |
| `connector.logout` | `POST /api/v1/connectors/{id}/logout` | ✓ |   |   |
| `connector.channel` | `PUT /api/v1/connectors/{id}/channel` | ✓ |   |   |

## lan

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `lan.status` | `GET /api/v1/lan` | ✓ |   |   |
| `lan.update` | `PUT /api/v1/lan` | ✓ |   |   |
| `lan.startPairing` | `POST /api/v1/lan/pairing` | ✓ |   |   |
| `lan.stopPairing` | `DELETE /api/v1/lan/pairing` | ✓ |   |   |
| `lan.answerPairing` | `POST /api/v1/lan/pairing/answer` | ✓ |   |   |
| `lan.deleteDevice` | `DELETE /api/v1/lan/devices/{id}` | ✓ |   |   |
| `lan.pair` | `POST /api/v1/lan/pair` | ✓ | ✓ |   |
| `lan.me` | `GET /api/v1/lan/me` | ✓ | ✓ |   |

## doc

| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 |
|---|---|---|---|---|
| `doc.list` | `GET /api/v1/docs` | ✓ | ✓ |   |
| `doc.create` | `POST /api/v1/docs` | ✓ | ✓ |   |
| `doc.import` | `POST /api/v1/docs/import` | ✓ | ✓ |   |
| `doc.get` | `GET /api/v1/docs/{id}` | ✓ | ✓ |   |
| `doc.submit` | `POST /api/v1/docs/{id}/submit` | ✓ | ✓ |   |
| `doc.markdown` | `GET /api/v1/docs/{id}/markdown` | ✓ | ✓ |   |
| `doc.demo` | `POST /api/v1/docs/{id}/demo` | ✓ |   |   |
