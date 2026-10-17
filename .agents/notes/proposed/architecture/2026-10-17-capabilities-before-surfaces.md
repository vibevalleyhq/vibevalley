# Agent Note: 先有能力，再有入口：一张能力表，接口、命令行、管家、帮工都从它来

Status: proposed

## Problem

农场能做的事（派活、合并、开频道、定时、记忆……）现在从七个入口进来，每个入口各自接一遍：

| 入口 | 谁用 | 能做的事从哪来 |
|---|---|---|
| HTTP 接口 | Flutter、院门后的设备 | `protocol/api.go` 的 86 个 `//vibevalley:route`，shapegen 生成，handler 一个方法转给一个服务 |
| 管家的工具 | 管家（DeepSeek） | `manager/tools.go` 手写的 21 个，再加 `pkg/agent` 自带的 `remember`、`rewrite_memory`、`search_archive`、`load_skill` |
| MCP | 帮工（Claude Code、Codex、pi……） | `mcp/mcp.go` 手写的 4 个：`farm_say`、`farm_read`、`farm_inbox`、`farm_who` |
| 聊天软件、语音 | 主人在外面说话 | 不是工具：文字交给 `Manager.Say`，语音交给 `Manager.Call`，之后由管家的工具干活 |
| 院门 | 主人配对过的设备 | 整套 HTTP 接口，`gate.go` 里写死不放 `lan.*` 的管理 |
| 定时、计划 | 服务端自己 | 直接调服务（`issue/dispatch.go` 的 `scheduled`、`playbook.go` 的 `follow`） |
| 命令行 | 终端、脚本、编码 agent | **没有**。`cmd/vibevalley` 是另一个 agent 的对话程序，不连服务端 |

后果：

- **没有命令行**。主人在终端里、编码 agent 在 shell 里、验证 skill 里，要动农场只能手写 `curl`。
- **谁能做什么没有写在一处**。管家能派活、合并、定时，不能建项目、改档案、改设置；帮工只能在频道里说话，读不到自己的工单；院门放什么写死在 `gate.go`。这些是有意的还是没顾上，代码里看不出来。
- **同一件事，几个入口的规则不一样**：
  - 派活：写好的工单开工（`Issue.Start`）满了就排队；管家的 `dispatch` 直接调 `Issue.Hire`，满了就拒绝，工单在帮工开工的同时才补上（`issues.Ran`）。
  - 看改动：主人看（`Issue.Review`）算进游戏，管家看（`Issue.Changes`）不算。这个区别是对的，但靠两个入口各调一个方法维持，不是靠传进去的「谁在看」。
  - `POST /api/dispatch` 叫派活，其实是 `Manager.Heard`：把一句话交给管家，安静地处理。
- **接口里有没人调的**：Flutter 不调 `worker.activities`、`progress.carryCoins`，别的入口也不调。
- **加一个能力要接好几处**：服务、`api.go`、handler、Flutter、管家的工具（要不要）、MCP（要不要），漏了哪处也不报错。

## Proposal

**能力是第一位的，入口是皮。** 一个能力就是 `api.go` 里的一个操作（`group.op`，已经有方法、路径、请求和返回的形状）。给每个操作补上「谁能用」，各个入口从这张表生成或检查，不再各自手接。这和 [先有概念，再有皮](2026-10-15-concepts-first.md) 是一回事：服务端按概念分模块，入口只是把这些模块交给不同的人。

### 1. 能力表：在 api.go 里给每个操作写明谁能用

`//vibevalley:route` 旁边加一行 `//vibevalley:can`，列出能用它的人，取值是封闭的：

| 取值 | 是谁 | 从哪个入口 |
|---|---|---|
| `owner` | 主人在农场那台电脑上 | Flutter、命令行 |
| `remote` | 主人配对过的设备 | 院门 |
| `manager` | 管家 | 管家的工具 |
| `worker` | 帮工 | MCP |

例：

```go
//vibevalley:route issue.start POST /api/issues/{id}/start
//vibevalley:can owner remote manager
IssueStart(ctx context.Context, pID string) (Dispatched, error)
```

- shapegen 读它，没写 `can` 的操作生成失败。
- 读的操作和写的操作不另外标：HTTP 方法已经说明了。
- 给模型看的说明（管家的工具、MCP 的工具要的中文 description）也写在这里，用 `//vibevalley:tool <名字> <说明>`；没有它的操作不给模型用。

### 2. 入口从能力表来

| 入口 | 怎么来 | 这一步做什么 |
|---|---|---|
| HTTP | 和现在一样 | 不变 |
| 命令行 | shapegen 写出 Go 的 `protocol.Client`（实现同一个 `Handlers` 接口）和命令表 | 新增，见下面第 3 节 |
| 院门 | 只放 `can` 里有 `remote` 的操作 | 替掉 `gate.go` 里写死的 `lan.*` |
| 管家的工具 | 先**检查**：管家的每个工具都对得上一个 `can manager` 的操作；`can manager` 的操作都有工具 | 以后再看要不要直接生成 |
| MCP | 同上，对 `worker` | 补不补帮工的能力，按第 5 节主人定的来 |
| 聊天软件、语音 | 不变：说话交给管家 | 以后可以加斜杠命令，一条命令对一个 `owner` 操作 |
| 定时、计划 | 不变：服务端自己调服务 | — |

管家的工具先只检查、不生成：它们的说明和参数是为模型调过的（`dispatch` 的参数是档案的名字和一句活，不是工单的 id），硬从接口生成会变差。检查已经能保证「表里写了管家能做，管家就真的能做」。

### 3. 命令行：接口的一张皮

- 只当服务端的客户端：命令行经 HTTP 调服务端，不自己打开 `vibevalley.db`；核心状态只有一份，归服务端。
- 命令从命令表来：`vibevalley <组> <操作> [路径参数] [--json 请求体]`，例如 `vibevalley issue start tDS4CG8AX`。另加 `state`（一帧 `StateFrame`，`--watch` 一直跟着）和 `events`。
- 连哪个服务端：`--server`，或者 `VIBEVALLEY_SERVER`，默认 `http://127.0.0.1:8787`，和 Flutter 的 dart-define 同一个名字。
- 输出默认 JSON，给脚本和 agent 读；`--pretty` 给人看。
- 手写的只有几个组合动作，也建在 `Client` 上：`issue run <id> --wait`（开工、跟着 `/api/state` 等到「等你看」、打出改动）。
- 名字：现在的 `cmd/vibevalley` 不带子命令时还是对话；其余子命令是客户端。

### 4. 一个能力只有一条规则，入口之间的差别传进服务

- 「谁在做」作为参数传进服务，像计划已经在做的 `protocol.PlaybookActor`：`Issue.Changes(id, by)` 由服务决定主人看算不算进游戏，去掉 `Review` 和 `Changes` 两个方法。
- 派活只有一个入口的规则：管家的 `dispatch` 先写下工单，再走 `Issue.Start`，和主人派的一样排队；「满了先请走最久没干活的」留在 `Hire` 里，两条路都经过它。
- `issue.dispatch`（`POST /api/dispatch`）改名成它实际做的事：交给管家的一句话（`manager.hear`）。
- 没人调的操作，要么接上，要么删掉；加一个检查：每个操作至少有一个入口用它（Flutter 的生成客户端里有调用，或者 `can` 里有 `manager`、`worker`）。

### 5. 能力上的空缺，要主人定

盘下来，下面这些现在做不到。每条都要主人定「补」还是「有意不给」，定了写进 `can`：

| 能力 | 现在 | 建议 |
|---|---|---|
| 帮工读自己的工单、工单串 | 做不到，只能读频道 | 补：`issue.find`、`channel.history` 给 `worker`，只限自己的 |
| 帮工报「卡住了，要主人拿主意」 | 只能在频道里说 | 补，和 [权限请求画成杂草](../feature/2026-10-10-permission-requests-as-weeds.md) 一起想 |
| 管家建项目、改档案、改设置、改农机 | 做不到 | 不给：这些是主人的配置，管家改了主人不知道 |
| 管家看记忆、帮档案记事 | 只能记自己的 | 待定 |
| VibeValley 自己的农机上的帮工记事 | `oarruntime` 关掉了（`NoMemory`） | 待定：记忆归档案，不归一次执行 |
| 院门后的设备管院门 | 不给 | 保持不给 |

### 6. 能力表画成文档

shapegen 另写一份 `docs/reference/capabilities.md`：每个能力一行，列出它在哪几个入口、对应的命令行命令和管家工具。生成的，`go run ./tool/shapegen -check` 查它是不是最新，所以这张表总是对的。

### 做的顺序

1. `//vibevalley:can` 和 `//vibevalley:tool`，给 86 个操作都写上；生成能力表的文档；院门改成按 `remote` 放。
2. 生成 `Client` 和命令表，做命令行；写 `verify-dispatch`，步骤就是命令行的几条命令，真的派一次活。
3. 收拢第 4 节的几处：派活一个入口、`Changes` 带上「谁在看」、改 `issue.dispatch` 的名字、处理没人调的操作。
4. 检查管家的工具、MCP 和能力表对得上；按第 5 节主人定的补帮工的能力。

## Alternatives considered

**只加一个手写的命令行。** 最快，但它会是第八个各自接一遍的入口，几个月后就和接口对不上。没选。

**命令行直接打开数据库，不经服务端。** 服务端没开也能用；但服务端开着时就有两份核心状态，违反「核心状态只有一份」。没选。

**管家的工具、MCP 全部从接口生成。** 一处都不用手写；但模型用的工具要的是模型看得懂的参数和说明，和给程序用的接口不是一个形状（管家派活给的是档案的名字和一句话）。先检查，等能力表稳定了再看哪些能生成。

**能力表另放一个文件（YAML）。** 和 `api.go` 分开，加操作时会忘了改它；写成同一处的注释，shapegen 一起读，漏了就生成失败。

## Acceptance criteria

- `api.go` 的每个操作都有 `can`，没有就 `shapegen` 失败。
- `docs/reference/capabilities.md` 由 shapegen 写出，`-check` 查它最新。
- 院门放行的操作和 `can remote` 一致，有测试。
- `vibevalley issue add`、`issue start`、`state`、`worker merge` 能对着一个临时的服务端用；测试经 `Client` 走一遍每个操作。
- 管家的工具和 MCP 的工具都对得上 `can` 里的 `manager`、`worker`，有测试；加一个 `can manager` 的操作不加工具，测试失败。
- 派活只剩一条规则：管家派的也先有工单，满了排队。
- 每个操作至少有一个入口用它。

## Risks

- `can` 写错了就是权限写错了：`remote` 放多了，院门后的设备能做本该只在本机做的事。第一次写 `remote` 时逐条对照 `gate.go` 现在的放行，改的时候在 PR 里单独列出。
- 管家派活改成先写工单、满了排队以后，管家原来「满了就告诉主人派不出去」的说法要跟着改，不然主人以为没派。
- 命令行和对话共用 `cmd/vibevalley` 一个名字，子命令和对话里的输入可能混淆；对话只在不带子命令时打开。
- 第 5 节里给帮工的能力一旦给了，帮工就能读到更多东西；只给「自己的」，在服务里按执行的身份查，不靠帮工自觉。
