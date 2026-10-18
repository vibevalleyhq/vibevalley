# Agent Note: 先有能力，再有入口：一张能力表，接口、命令行、院门都从它来

Status: implemented

## Problem

农场能做的事（派活、合并、开频道、定时、记忆……）原来从七个入口进来，每个入口各自接一遍：HTTP 接口（Flutter、院门后的设备）、管家的工具、帮工的 MCP、聊天软件和语音、院门、定时和计划，以及没有的命令行。后果：

- **没有命令行**：主人在终端里、编码 agent 在 shell 里、验证 skill 里，要动农场只能手写 `curl`。
- **谁能做什么没有写在一处**：院门放什么写死在 `gate.go`；管家、帮工能做的是有意的还是没顾上，代码里看不出来。
- **同一件事几个入口的规则不一样**：派活一条路排队、一条路拒绝；主人看改动算进游戏、管家看不算，靠调两个不同的方法维持。
- **接口的名字各说各的**：同一件事有 `add`/`create`/`open`、`edit`/`update`、`remove`/`delete`、`find`/`get`；工单的生命周期挂在 `/api/workers/{id}` 下；`issue.queue {queued}` 一个布尔兼两件事；有没人调的接口。
- **加一个能力要接好几处**，漏了哪处也不报错。

## Decision

**能力是第一位的，入口是皮。** 一个能力就是 `protocol/api.go` 里的一个操作（`group.op`，有方法、路径、请求和返回的形状），每个操作写明谁能用，各个入口从这张表生成或检查（和[先有概念，再有皮](../../proposed/architecture/2026-10-15-concepts-first.md)是一回事）。全部操作和谁能用见生成的 [capabilities.md](../../../../docs/reference/capabilities.md)。

- **能力表写在 `api.go`**：`//vibevalley:route` 旁边一行 `//vibevalley:can`，取值封闭：`owner`（主人在这台电脑上：Flutter、命令行）、`remote`（主人配对过的设备：院门）、`manager`、`session`。shapegen 读它，没写 `can` 的操作生成失败。读写不另标，HTTP 方法已经说明。
- **入口从能力表来**：HTTP 照旧；命令行由 shapegen 写出 Go 的 `protocol.Client`（实现同一个 `Handlers` 接口）和命令表；院门只放 `can` 里有 `remote` 的操作，替掉了 `gate.go` 写死的放行；`docs/reference/capabilities.md` 由 shapegen 写出，`-check` 查它最新。
- **命令行只是服务端的一张皮**：`vibevalley <组> <操作> [路径参数] [--json 请求体]`，经 HTTP 调服务端，不自己打开 `vibevalley.db`（核心状态只有一份）；连哪个服务端是 `--server` 或 `VIBEVALLEY_SERVER`。手写的只有建在 `Client` 上的组合命令（`state`、`events`、`issue run`）和不经服务端的本机工具（`runtime chat`、`oar`）。直接聊不算农场的活：没有工单，不进核心状态、轨迹和花费。
- **接口按五条收敛**：组是概念（`gate`、`game`、`channels`，不是 `lan`、`progress`、`chat`）；动词一套（`list`、`get`、`create`、`update`、`delete`，`save` 只给客户端定 id 的整份写入，`check` 只校验，领域动词只留给不是增删改查的）；工单的生命周期挂在工单上，按工单 id 找它最新的帮工（后来进一步收成[工单](../../../../docs/subsystems/issue.md)的 `issue.status`）；一个意图一个操作，不用布尔开关兼两件；`update` 只改给出的字段，路径的 id 算数。没人调的 `worker.activities`、`progress.carryCoins`、`server.end` 删了。
- **一条规则，差别作为参数传进服务**：「谁在看」传给 `Issue.Changes(id, by)`，由服务决定主人看算不算进游戏，不再靠两个方法。
- **模型的工具不从能力表生成**：管家和帮工的工具要的是模型看得懂的参数和说明（管家派活给的是档案的名字和一句话），和给程序的接口不是一个形状；工具表在 `internal/tool`，谁能用哪些由[管家是一份档案，只是能力多](../../proposed/architecture/2026-10-17-manager-is-an-agent.md)管。

## Alternatives considered

**只加一个手写的命令行。** 最快，但它会是第八个各自接一遍的入口，几个月后就和接口对不上。

**命令行直接打开数据库，不经服务端。** 服务端没开也能用；但服务端开着时就有两份核心状态，违反「核心状态只有一份」。

**管家的工具、MCP 全部从接口生成。** 一处都不用手写；但模型用的工具和接口不是一个形状，硬生成会变差。

**能力表另放一个文件（YAML）。** 和 `api.go` 分开，加操作时会忘了改它；写成同一处的注释，shapegen 一起读，漏了就生成失败。

## Consequences

- 加一个能力：写服务、在 `api.go` 加操作和 `can`、跑 shapegen；Flutter 的客户端、命令行的命令和能力表文档跟着生成。
- `can` 写错了就是权限写错了：`remote` 放多了，院门后的设备能做本该只在本机做的事；改 `remote` 时在改动里单独列出。
- 还没收完的两件归[管家是一份档案，只是能力多](../../proposed/architecture/2026-10-17-manager-is-an-agent.md)：`can` 去掉 `manager`、`session`（agent 能调什么写在档案上）；管家派活也先写工单、满了排队，和主人派的一条规则。把命令行跑一遍真派活的验证 skill 归[用 VibeValley 开发 VibeValley](../../proposed/process/2026-10-18-build-vibevalley-with-vibevalley.md)的 `verify-feature-loop`。

## Verification

- shapegen 对没写 `can` 的操作失败；`go run ./tool/shapegen -check` 查 `gen.go`、Flutter 的 `lib/gen` 和 `capabilities.md` 都是最新。
- 院门放行的操作和 `can remote` 一致，`gate` 有测试。
- `verify-server` 用命令行对着一个临时的服务端调接口；`cmd/vibevalley` 的测试经 `Client` 走 `issue run` 等组合命令。
