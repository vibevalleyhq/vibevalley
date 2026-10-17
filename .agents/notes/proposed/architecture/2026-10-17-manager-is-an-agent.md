# Agent Note: 管家是一份内置档案

Status: proposed

## Problem

管家现在是半个档案。它占着档案的 id：`protocol.ManagerAgent = "manager"`（`server/internal/protocol/shapes.go:10`），工单能派给它（`IsForManager`），记忆挂在它名下（`server/internal/memory/memory.go:283`），轨迹和 Session 的放在一起。但它不是一份存下的档案：农机和模型在配置的 `manager.runtime`、`manager.model`（`server/internal/base/config.go:31`），拿 `manager` 存档案被拒绝（`server/internal/agent/agent.go:140`）。

所以每个碰到档案的地方都要为它开特例：记忆有两套接口（`agent.memories` 和 `manager.memories`，后者的形状 `ManagerMemory` 多出 `Runtime`、`File`、`Carried`），频道的发言人分 `'worker'` 和 `'manager'` 两种，改管家的模型要改配置文件。

## Proposal

- 管家是一份内置的档案：id `manager`，新字段 `role`：管家是 `manager`，其余档案不填。内置的意思是：服务端开机时确保它在，主人不能删、不能改 `role`，`agent.delete manager` 拒绝。
- 农机和模型从配置挪进这份档案：`agent save manager` 能改；配置的 `manager.runtime`、`manager.model` 删掉，按「不留兼容」在加载时把旧值写进档案一次（`agent/cast.go` 那样）。
- 名字 Manager 只留给这个角色和派活的服务 `internal/manager`；界面上还叫管家。不改叫 Agent：`Agent` 指全部档案，`manager.hear`、`manager.archive` 是只有它有的，归到 `agent.*` 下读起来像对所有档案说的。
- 随之收敛的：
  - 记忆 `memory.*` 带 `agent`，`manager` 就是一个档案 id，`ManagerMemory` 多出的 `Runtime` 是档案的字段，`File` 和 `Carried` 并进 `memory.list` 的返回（[先有能力，再有入口](2026-10-17-capabilities-before-surfaces.md) 第 4 节）。
  - 频道的发言人 `participant.kind` 只剩 `user`、`agent`、`system`，`agent_id` 是 `manager` 的就是管家。
  - `manager.*` 只剩 `manager.hear`、`manager.open`、`manager.archive.*`。
- 管家能用什么工具仍由 `internal/manager` 定，不进档案的 `skills`、`mcpServers`：它的工具是派活的规则，主人改了会让派活失灵。

## Alternatives considered

**管家改叫 Agent。** `Agent` 已经指全部档案；另外 `pkg/agent`（我们自己的 agent 循环）和配置里 `cmd/vibevalley` 的 `Agent.Model` 也叫 agent，再加一个就是第四个意思。

**维持现状。** 每个碰到档案的地方继续开特例；记忆、发言人、配置三处的特例已经在，以后档案每加一样东西（长相、技能），都要问一遍管家有没有。

## Acceptance criteria

- `agent list` 里有 `manager`，`role: manager`；`agent save manager` 能改它的农机和模型，删它、改它的 `role` 被拒绝。
- 配置里没有 `manager.runtime`、`manager.model`；旧的配置打开一次后，值在档案里。
- 记忆、频道发言人、轨迹里没有为管家写的特例分支（`grep -rn "ManagerAgent" server/internal` 只剩档案的定义和派活的判断）。
- `go vet ./... && go test ./...`、`shapegen -check`、`bun run flutter:check` 通过。

## Risks

- 主人在档案页把管家的农机改成写代码用的那种，管家的派活工具不变，但模型和人设变了，派活的质量会变；档案页对 `role: manager` 的档案宜只放农机、模型两项。
- 档案存在 `config.json`，管家进了档案，坏掉的 `config.json` 也会让管家起不来；开机时缺了就按默认补上。
