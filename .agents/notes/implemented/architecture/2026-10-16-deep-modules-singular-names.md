# Agent Note: 按业务分深模块，包名用单数和自己的词

Status: implemented

## Problem

[一个概念一个包](2026-10-16-a-package-per-concept.md) 把服务端分成了 `base`、`projects`、`memory`、`runs`、`chat`、`tickets`、`manager`、`channels`、`game`。用下来有四处不对：

- **`channels` 和频道撞名**：概念里的频道是群聊的频道（`chat` 的 `Conversation`），`channels` 包里装的却是三样互不相干的东西：连接器（微信、飞书、QQ）、语音、院门。
- **`base` 装了业务**：核心状态（`Site`）、帮工档案和技能书（`Store`）、钥匙和语音设置（`Settings`），和数据库、`Hub` 这些地基混在一起；`types.go` 里各服务之间传的形状也都堆在这里，不在它们的主人那里。
- **一个包里有两块业务**：`runs` 里有农机（探测、额度、花费），和执行无关，只用到 `base`；`tickets` 里有工单、种植计划、定时和巡查四块。
- **名字不是我们的词**：包名是复数（`projects`、`runs`、`tickets`、`channels`），`tickets` 还是代码里已经不用的叫法（代码叫 Issue），`game` 是皮上的说法。

## Decision

- 一个包是一块业务：接口窄、里面深，不为了分而切成一堆薄包。
- 包名用单数，用[用语表](../../../../docs/README.md#用语)和[概念](../../../../docs/concepts.md)里的词：`chat` 改名 `channel`，`tickets` 拆成 `issue`、`playbook`、`schedule`，`channels` 拆成 `connector`、`voice`、`gate`，`runs` 拆成 `runtime` 和 `run`，`projects` 改名 `project`，`game` 改名 `ledger`。
- `base` 只放地基。`Site`、`Settings`、`Store` 各成一个包：`site`、`setting`、`agent`；搬家的代码从 `farm` 挪到 `migrate`，`farm` 只做组装（`migrate` 后来整个删了，见 [只有一份表结构，不认旧数据](2026-10-16-one-schema-no-old-data.md)；`farm` 现在叫 `workspace`）。
- 形状跟着主人走：`base/types.go` 拆掉，每个形状放进定义它的包的 `types.go`。主人在上层、下层也要用的形状，放在下层那个包（`Workplace` 在 `project`，`FinishedTurn` 在 `memory`）。
- 频道照 Discord：频道 → 消息 → 挂在消息下面的串。初期只有一个人（主人），没有成员和权限。外面的聊天软件经 `connector` 接到一个频道上。

`ledger` 后来改回 `game`，装下服务端全部的游戏：[服务端的游戏收在一处](2026-10-16-game-in-one-place.md)。

包的清单、每个包里的服务和顺序见 [server/README.md](../../../../server/README.md#服务)「服务」；频道见 [概念](../../../../docs/concepts.md)。

## Alternatives considered

**保留 `base` 原样，只拆 `channels`。** 改动最小。没选：`base` 里的 `Site`、`Store`、`Settings` 是业务，每个包都 import `base`，等于每个包都能碰到全部业务；形状堆在 `types.go` 里，看不出谁是主人。

**更细：轨迹、令牌、合并各成一个包。** 它们和执行、工单共用会话的规则和锁，拆开要导出一大片包内的东西，边界是浅的。留在 `run`、`issue` 里。

**种植计划叫 `plan`。** 和 `Issue.Plan`、界面上的「计划」一致。没选：代码里的类型、协议、用语表都叫 Playbook，包名和类型一致更好找。

**账本留叫 `game`。** 没选：`game` 是皮上的说法；这个包做的是记账和从账本折出进度，经验也是账本的一部分。

**`setting` 和 `agent` 合进一个 `config` 包。** 它们存在两个文件、由不同的页面改，钥匙还有自己的安全约定（0600、不进日志）。分开。

## Consequences

- `base.App` 不再自带任何服务：`site`、`setting`、`agent` 和别的包一样是 `farm.go` 的 `layers` 里的一层，每个包的 `world_test.go` 也要带上它们。`site` 最先建，它的关闭挂在 fx 的生命周期上，所以 `state.json` 在全部服务停了以后才写。
- 内部的 `agent` 包和 `pkg/agent`（VibeValley 自己的 agent）同名。两个都要用的文件（`runtime/runtime.go`、`manager/manager.go`、`manager/world_test.go`）把 `pkg/agent` 起名 `vvagent`。
- `runtime` 和 Go 标准库同名；现在没有文件两个都用，用到时给标准库起别名。
- 有几处局部变量和包同名（`schedule` 里的 `channel`、`agent`）。编译器允许，在那个作用域里用不到包。
- 存盘格式、HTTP 接口和行为没变。旧的家目录照常打开。
- 文档和 Note 里指向文件的路径都改成了新的；描述历史的旧包名照原样留着。

## Verification

- `go vet ./...` 通过；`go test ./internal/... ./cmd/...` 全部通过，测试函数 245 个，和改之前一样。`pkg/smith` 的 grok 测试在全量并行跑时偶尔超时，单独跑通过；这次没有改 `pkg/smith`。
- `go run ./tool/shapegen -check` 通过，`bun run flutter:check` 通过。
- `server/internal/` 下没有 `chat`、`tickets`、`channels`、`runs`、`projects`、`game`；`base` 里没有 `Site`、`Store`、`Settings` 和 `types.go`。
