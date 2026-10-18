# 服务端：还没拆成子系统的部分

`server` 是 Go 模块 `vibevalley`，只听 127.0.0.1:8787；局域网里的设备经「院门」进来。包怎么分、服务怎么组装、测试见 [server/README.md](server/README.md)；存了什么、配置见 [architecture.md](docs/architecture.md)。核心状态只经 `Core.Apply` 改；纯规则在 `protocol` 包，只有服务端用的在拥有它的包里（`session/facts.go`、`session/rules.go`）。

已经拆成子系统的在 [docs/subsystems](docs/subsystems/README.md)：[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md)（含额度、花费和上限）、[项目](docs/subsystems/project.md)（含 GitHub 检测）、[田头](docs/subsystems/channel.md)（含连接器和 Inbox）、[管家](docs/subsystems/manager.md)（含巡查）、[定时](docs/subsystems/schedule.md)、[种植计划](docs/subsystems/task.md)、[记性](docs/subsystems/memory.md)。这里只留其余的。

## 设置

工作台的「设置」（`/settings`，`setting/setting.go`；[理由](.agents/notes/implemented/feature/2026-10-12-title-screen-and-settings.md)）存 DeepSeek 的钥匙、Agora 的 App ID 和 Certificate，和语音设置（[voice.md](docs/reference/voice.md)「配置」）。存在 `$VIBEVALLEY_HOME/settings.json`（0600）。设置里的优先于配置（[architecture.md](docs/architecture.md)「配置」）；每次用时现取。页面只看到每样从哪来和最后四个字，钥匙不出服务端、不进日志。设置里还有记性的来源（[记性](docs/subsystems/memory.md)）。服务端的日志整行过一遍 `base.Redact`（`base/redact.go`）：长得像钥匙的（`sk-…`、`ghp_…`、`xoxb-…`、`AKIA…`、JWT、私钥块、农场自己的会话令牌）和跟在 `api_key=`、`token:`、`password=`、`Bearer` 这类名字后面的值，写成 `[redacted]`。

## 院门

手机、另一台 Mac 和这台电脑用同一个农场（`gate/gate.go`；[理由](.agents/notes/implemented/feature/2026-10-14-yard-gate.md)），在「设置」的「院门」（`/settings/gate`）管。

- **另一个监听**：在所有网卡上听 `lan.port`（默认 8790），默认关着。
- **只放这些**：[能力表](docs/reference/capabilities.md)里院门一列打了 ✓ 的接口（`api.go` 的 `//vibevalley:can remote`，`internal/gate` 按 `protocol.Endpoints` 匹配）和两条流，不放 `/mcp`；别的答 403。每个请求要带 `Authorization: Bearer <钥匙>`；只有 `POST /api/v1/gate/pair` 不要。院门自己的管理接口没有 `remote`，只在本机能用。
- **配对**：主人点「添加设备」，得到一个配对码（2 分钟有效，用一次就作废），画成 `vibevalley://pair?…` 的二维码。设备带码来要钥匙，等主人在本机点头。数据库只存钥匙的 SHA-256。
- **移除**一台设备或关上院门，它的连接当场断开。
- **明文**：院门走 HTTP，不加密，只在信得过的网络里开。

## 游戏

服务端的游戏都在 `game` 包（`Workspace` 上的 `Game`）：账本（`ledger.go`）、按 commit 数算的等级（`commits.go`）、主人刚点的空地（`beds.go`）。账本怎么折（金币、连胜、成就、一个事实记哪几笔）只有 `game` 用，在 `game/progress.go`；出帧和 `Reduce` 要用的在 protocol：地里长什么和特效在 `game_view.go`，帮工在哪块地、做过什么在 `game_play.go`。业务的服务不 import `game`（[理由](.agents/notes/implemented/architecture/2026-10-16-game-in-one-place.md)）。

**空地**：主人点一块空地再说话，`Game` 记下这块地 10 秒。这期间新雇的第一个帮工先站到第一块空着的地，`Game` 再施加 `station` 事实把它挪过去；那块地已经有人就不挪。

**特效**：金币、升级、成就、没做成的惩罚由 `EffectsOf` 从事实和折之前的状态算出，`Core` 和帧一起发。

**农场账本**（`game/ledger.go`；[理由](.agents/notes/implemented/feature/2026-10-11-achievements.md)）是 `game_ledger` 表：值得记的事，一条一行，按顺序。金币、连胜、成就和每个档案的战绩都由它折出来（`game/progress.go`），规则见 [farm-ui.md](docs/reference/farm-ui.md)「计分」。

- 账本自己看事件流，用 `game/progress.go` 的 `entriesFor` 读出要记的（收获、没做成、冲突、派出、拆好计划、升级、带话……）；业务的服务不调它。只有主人在应用里做的几件事（语音接通、看收成清单、挂称号）在 HTTP 那一层记。
- 记一条就施加 `progress` 事实，带来金币或成就时带上 `news`。
- 启动时整本重折，所以规则改了重启就按新规则算。

## 重启

[理由](.agents/notes/implemented/architecture/2026-10-10-restart-keeps-the-farm.md)。

- 帮工和停在半路的那一轮见 [帮工](docs/subsystems/session.md)。
- 种植计划跟着工单回来：正在拆的放弃，做到一半的暂停。
- 田头从数据库回来；已交付没看到的消息退回未交付。
- 金币、连胜、成就从账本重折。

