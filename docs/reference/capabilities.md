# 能力表

由 `server/tool/shapegen` 从 `server/internal/protocol/api.go` 的 `//vibevalley:route` 和 `//vibevalley:can` 写出，不手改；`go run ./tool/shapegen -check` 查它是不是最新。为什么这样分见 [先有能力，再有入口](../../.agents/notes/proposed/architecture/2026-10-17-capabilities-before-surfaces.md)。

| 谁 | 是谁 | 从哪个入口 |
|---|---|---|
| 主人 | 主人在农场那台电脑上 | Flutter、命令行 |
| 院门 | 主人配对过的设备 | 院门只放这一列打了 ✓ 的 |
| 管家 | 管家 | 管家的工具 |
| Session | 帮工 | 带钥匙的命令行 |

`GET /api/state` 和 `GET /api/events` 是 SSE，不在 `Handlers` 里：主人和院门都能读。

## server

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `server.health` | `GET /api/health` | ✓ | ✓ |  |  |

## manager

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `manager.open` | `POST /api/manager/open` | ✓ | ✓ |  |  |
| `manager.hear` | `POST /api/manager/hear` | ✓ | ✓ |  |  |
| `manager.memories` | `GET /api/manager/memories` | ✓ | ✓ |  |  |
| `manager.remember` | `POST /api/manager/memories` | ✓ | ✓ | ✓ |  |
| `manager.forget` | `DELETE /api/manager/memories/{memory}` | ✓ | ✓ |  |  |
| `manager.listArchive` | `GET /api/manager/archive` | ✓ | ✓ | ✓ |  |
| `manager.getArchive` | `GET /api/manager/archive/{name}` | ✓ | ✓ |  |  |

## setting

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `setting.load` | `GET /api/settings` | ✓ | ✓ |  |  |
| `setting.check` | `POST /api/settings/check` | ✓ | ✓ |  |  |
| `setting.save` | `PUT /api/settings` | ✓ | ✓ |  |  |

## channel

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `channel.say` | `POST /api/say` | ✓ | ✓ |  |  |
| `channel.create` | `POST /api/channels` | ✓ | ✓ | ✓ |  |
| `channel.update` | `PUT /api/channels/{id}` | ✓ | ✓ | ✓ |  |
| `channel.history` | `GET /api/channels/{id}/messages` | ✓ | ✓ | ✓ |  |
| `channel.markRead` | `POST /api/channels/{id}/read` | ✓ | ✓ |  |  |

## schedule

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `schedule.create` | `POST /api/schedules` | ✓ | ✓ | ✓ |  |
| `schedule.list` | `GET /api/schedules` | ✓ | ✓ | ✓ |  |
| `schedule.update` | `PUT /api/schedules/{id}` | ✓ | ✓ |  |  |
| `schedule.delete` | `DELETE /api/schedules/{id}` | ✓ | ✓ | ✓ |  |

## issue

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `issue.comment` | `POST /api/issues/{id}/comment` | ✓ | ✓ | ✓ |  |
| `issue.changes` | `GET /api/issues/{id}/changes` | ✓ | ✓ | ✓ |  |
| `issue.merge` | `POST /api/issues/{id}/merge` | ✓ | ✓ | ✓ |  |
| `issue.resolve` | `POST /api/issues/{id}/resolve` | ✓ | ✓ |  |  |
| `issue.cancel` | `POST /api/issues/{id}/cancel` | ✓ | ✓ | ✓ |  |
| `issue.list` | `GET /api/issues` | ✓ | ✓ |  |  |
| `issue.get` | `GET /api/issues/{id}` | ✓ | ✓ |  |  |
| `issue.runs` | `GET /api/issues/{id}/runs` | ✓ | ✓ |  |  |
| `issue.create` | `POST /api/issues` | ✓ | ✓ |  |  |
| `issue.update` | `PUT /api/issues/{id}` | ✓ | ✓ |  |  |
| `issue.delete` | `DELETE /api/issues/{id}` | ✓ | ✓ |  |  |
| `issue.move` | `PUT /api/issues/{id}/move` | ✓ | ✓ |  |  |
| `issue.unqueue` | `POST /api/issues/{id}/unqueue` | ✓ | ✓ |  |  |
| `issue.start` | `POST /api/issues/{id}/start` | ✓ | ✓ | ✓ |  |
| `issue.reopen` | `POST /api/issues/{id}/reopen` | ✓ | ✓ |  |  |

## session

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `session.stop` | `POST /api/sessions/{id}/stop` | ✓ | ✓ | ✓ |  |
| `session.list` | `GET /api/sessions` | ✓ | ✓ |  |  |
| `session.get` | `GET /api/sessions/{id}` | ✓ | ✓ |  |  |

## playbook

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `playbook.plan` | `POST /api/playbooks` | ✓ | ✓ | ✓ |  |
| `playbook.updateNode` | `PUT /api/playbooks/{id}/nodes/{node}` | ✓ | ✓ | ✓ |  |
| `playbook.deleteNode` | `DELETE /api/playbooks/{id}/nodes/{node}` | ✓ | ✓ | ✓ |  |
| `playbook.act` | `POST /api/playbooks/{id}/act` | ✓ | ✓ | ✓ |  |
| `playbook.nodeAct` | `POST /api/playbooks/{id}/nodes/{node}/act` | ✓ | ✓ | ✓ |  |
| `playbook.changes` | `GET /api/playbooks/{id}/changes` | ✓ | ✓ |  |  |
| `playbook.events` | `GET /api/playbooks/{id}/events` | ✓ | ✓ |  |  |

## game

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `game.chooseTitle` | `POST /api/game/title` | ✓ | ✓ |  |  |

## runtime

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `runtime.list` | `GET /api/runtimes` | ✓ | ✓ |  |  |
| `runtime.refresh` | `POST /api/runtimes/{id}/refresh` | ✓ | ✓ |  |  |
| `runtime.update` | `PUT /api/runtimes/{id}/settings` | ✓ | ✓ |  |  |
| `runtime.upgrade` | `POST /api/runtimes/{id}/upgrade` | ✓ | ✓ |  |  |

## agent

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `agent.list` | `GET /api/agents` | ✓ | ✓ |  |  |
| `agent.check` | `POST /api/agents/check` | ✓ | ✓ |  |  |
| `agent.save` | `PUT /api/agents/{id}` | ✓ | ✓ |  |  |
| `agent.delete` | `DELETE /api/agents/{id}` | ✓ | ✓ |  |  |
| `agent.memories` | `GET /api/agents/{id}/memories` | ✓ | ✓ |  |  |
| `agent.recall` | `GET /api/agents/{id}/recall` | ✓ | ✓ |  |  |
| `agent.remember` | `POST /api/agents/{id}/memories` | ✓ | ✓ |  |  |
| `agent.forget` | `DELETE /api/agents/{id}/memories/{memory}` | ✓ | ✓ |  |  |

## skill

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `skill.list` | `GET /api/skills` | ✓ | ✓ |  |  |
| `skill.save` | `PUT /api/skills/{id}` | ✓ | ✓ |  |  |
| `skill.delete` | `DELETE /api/skills/{id}` | ✓ | ✓ |  |  |

## project

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `project.list` | `GET /api/projects` | ✓ | ✓ | ✓ |  |
| `project.check` | `POST /api/projects/check` | ✓ | ✓ |  |  |
| `project.create` | `POST /api/projects` | ✓ | ✓ |  |  |
| `project.languages` | `GET /api/projects/{id}/languages` | ✓ | ✓ |  |  |
| `project.activity` | `GET /api/projects/{id}/activity` | ✓ | ✓ |  |  |

## voice

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `voice.session` | `POST /api/voice/session` | ✓ | ✓ |  |  |
| `voice.renew` | `POST /api/voice/renew` | ✓ | ✓ |  |  |
| `voice.start` | `POST /api/voice/agent` | ✓ | ✓ |  |  |
| `voice.stop` | `POST /api/voice/agent/stop` | ✓ | ✓ |  |  |

## connector

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `connector.list` | `GET /api/connectors` | ✓ | ✓ |  |  |
| `connector.login` | `POST /api/connectors/{id}/login` | ✓ | ✓ |  |  |
| `connector.verify` | `POST /api/connectors/{id}/verify` | ✓ | ✓ |  |  |
| `connector.logout` | `POST /api/connectors/{id}/logout` | ✓ | ✓ |  |  |
| `connector.channel` | `PUT /api/connectors/{id}/channel` | ✓ | ✓ |  |  |

## gate

| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |
|---|---|---|---|---|---|
| `gate.status` | `GET /api/gate` | ✓ |  |  |  |
| `gate.update` | `PUT /api/gate` | ✓ |  |  |  |
| `gate.startPairing` | `POST /api/gate/pairing` | ✓ |  |  |  |
| `gate.stopPairing` | `DELETE /api/gate/pairing` | ✓ |  |  |  |
| `gate.answerPairing` | `POST /api/gate/pairing/answer` | ✓ |  |  |  |
| `gate.deleteDevice` | `DELETE /api/gate/devices/{id}` | ✓ |  |  |  |
| `gate.pair` | `POST /api/gate/pair` | ✓ | ✓ |  |  |
| `gate.me` | `GET /api/gate/me` | ✓ | ✓ |  |  |
