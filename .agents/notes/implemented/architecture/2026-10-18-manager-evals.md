# Agent Note: 管家的错变成评测：主人标出做错的一轮，存成样例，改提示前后用真模型重放

Status: implemented

## Problem

Grok Bot 的内循环：bot 做错一次，就变成一条评测；修 harness、提示或推理，评测过了再上线；每个做得不好的 bot 都变成评测（幻灯片 36:05；[对照 Grok Bot](2026-10-18-always-on-manager.md)第 9 项）。

管家原来没有这一圈：

- 管家的测试用 `ai.FauxProvider` 扮演模型（`internal/manager/manager_test.go`、`input_test.go`），模型说什么是测试写死的。它们验证的是 harness（输入怎么拼、工具怎么跑、话发到哪），验证不了模型拿到这样的输入会不会做对。
- 黄金数据（`internal/manager/rules_golden_test.go`、`testdata/rules.jsonl.gz`）只覆盖纯函数的规则，比如巡查。
- 改 `managerSystemPrompt`（`internal/manager/manager.go`）或工具描述时，没有办法知道上次修好的错会不会又出现。
- [先采样，再验收](../../proposed/architecture/2026-10-14-sample-then-verify.md)第 2 步说的「故障回流成样本」是帮工改代码的故障，样本是仓库里的测试；管家的错（派错了人、不该说时说了、该问主人时自己合了）不在那里。

做错的那一轮，证据本来都在：`manager.jsonl` 只往后加，压缩也只是追加一行摘要（`internal/agent/brain/session.go`），原文都留着；管家的轨迹（`session.events`）里每一轮有 `user/message`，带 `seq` 和时间。缺的是把它们存成能重放的样例，和重放它的办法。

## Decision

一圈是这样走的：主人在管家页标出做错的一轮 → 家目录里多一个样例 → 修的人写几条固定的判断，放进仓库，`go test` 确认它红在录下的那一轮上 → 改提示、工具描述或 harness → 用真模型重放，每个样例采 5 次、至少过 4 次 → 提交时附上那张表。验证步骤在 [verify-manager-evals](../../../skills/verify-manager-evals/SKILL.md)。

### 1. 标出做错的一轮

- 接口 `manager.markWrong`（`POST /api/v1/manager/evals`，主人和院门能调）：`ManagerEvalRequest{On, Want}`，`On` 是管家轨迹里那一轮的 `user/message` 的 `seq`，`Want` 是主人说的「应该怎样」；回 `ManagerEval{ID, File}`。命令行跟着有 `vibevalley manager mark-wrong --json …`。没有这一步是 404（`Missing`）；不是 `user/message`、`want` 是空的、这句话没进对话的是 409。
- 管家页「轨迹」里，每一轮收到的话上浮出「这一轮做错了」（带 `icon-bug` 的贴图，和「评论」一样鼠标移上去或点一下才出现），写一句应该怎样、点「记下」；存好以后那句话下面标一行「标成了做错的一轮，存成了一条评测」，鼠标移上去看到文件。这个记号只在这次打开的页面里，刷新后不再显示：服务端不列已有的样例。

### 2. 存成样例

`internal/manager/evals.go` 的 `MarkWrong`：

1. 按 `On` 从管家的轨迹里找到那条 `user/message`，取它的时间和字。
2. 读 `manager/manager.jsonl` 的全部行（`internal/agent/brain.ReadLines`，不经 `Replay`，压缩前的原文也在），找第一条**时间不早于这一步、字以这一步的字开头**的 `managerInput`：`sendInput` 先记轨迹、后建消息，所以消息不早于这一步；轨迹里的字修剪过、超过 2000 字会截断，消息后面可能还拼着「这期间田头上的汇报」，所以比开头。
3. `before` = 它之前的那些行经 `Replay` 得到的消息（模型这一轮开始时看到的对话，不含请求前的临时压缩）；`input` = 这条输入；`did` = 从它起到下一条 `managerInput` 之前的消息，去掉轮后追加的压缩摘要。
4. 写 `manager/evals/<id>.json`（`id` 是 uuidv7，只有主人能读）：`id`、`created`、`model`、`want`、`memory`（标记时 `MEMORY.md` 的全文，不一定是那一轮时的）、`tools`（管家的工具和 `internal/agent/brain` 自带的，`remember`、`search_archive` 这些）、`before`、`input`、`did`（都是 `manager.jsonl` 里的原样一行）、空的 `expect`。缩进、不转义 HTML，方便人读和手写 `expect`。

农场现状不另存：[提示开头不变](2026-10-18-stable-prompt-prefix.md)以后，时间和农场现状（全文或变了的行）在每条输入里，`input` 和 `before` 就带着它们。样例是家目录里的私人文件，不进仓库。

### 3. 期望：几种固定的判断

`expect` 是一个封闭的集合，按 `kind` 分，类型是 `evals.go` 的 `evalExpect`：

| `kind` | 字段 | 过的条件 |
|---|---|---|
| `called` | `tool`，可选 `argContains` | 这一轮调了 `tool`，参数的 JSON 里有 `argContains` |
| `notCalled` | `tool` | 这一轮没调 `tool` |
| `silent` | | 这一轮没说一个字 |
| `says` | `contains` | 说的话里有 `contains` |
| `saysNot` | `contains` | 说的话里没有 `contains` |

纯函数 `evalCheck(expect, turn)` 返回没过的那几条，空就是过了；字段缺了或 `kind` 不认识的也算没过。它和 `evalKinds`、`evalProblem` 在 `evals_check_test.go`：只有测试用它，放在非测试文件里过不了 `go:deadcode`。`evalKinds` 不是 protocol 的联合，没有生成的成员表；`TestEvalCheckJudgesEveryKind` 遍历它，每一种都要有过的和不过的例子，加了一种没写判断，测试就红。`expect` 由修这个错的人写（开发用的编码 agent 或主人）：把 `want` 的话翻成几条判断。

### 4. 先红：样例要抓得住这次的错（离线，`go test` 里）

- 仓库里放挑过、去掉了私人内容的样例：`internal/manager/testdata/evals/*.json`。哪些进仓库由主人决定。现在只有一个照格式手写的例子 `think-before-dispatch.json`（主人说「先别派活，帮我想想」，管家却派了），不是录下的。
- `TestManagerEvalCasesCatchTheirError` 对每个样例检查：能解开；`input` 是 `managerInput`；`expect` 不为空、每条字段齐全；写到的工具管家都有（改了工具名，样例马上报错）；**录下的 `did` 必须过不了 `expect`**：录下的就是那次的错，判断要抓得住它（「先红了，才算抓住」）。目录是空的也算红。

### 5. 重放：用真模型，多采几次（联网，单独跑）

- `internal/manager/evals_live_test.go`，开头 `//go:build evals`，默认的 `go test ./...` 不编译它；`go vet -tags evals ./...` 查它能编过。
- `TestManagerEvalsLive` 对每个样例（仓库里的，加上 `VIBEVALLEY_EVALS` 指向的目录里的；还没写 `expect` 的跳过）：
  1. 照 `brainOf` 的样子建一个管家的大脑：现在的 `managerSystemPrompt + managerAgentPrompt`、样例的 `memory`（写进临时目录的 `MEMORY.md`）和 `before`，`NoSession`。
  2. 工具用现在的工具表，每个工具的 `Execute` 换成桩：同名的工具在 `did` 里有结果就按调用的先后给出，没有就返回「（评测里没有这个工具的结果）」。桩不碰农场。
  3. 送进 `input`，跑到这一轮停下，对这一轮的消息跑 `evalCheck`。
  4. 每个样例采 `VIBEVALLEY_EVAL_N` 次（默认 5），过了至少 `N − 1` 次（至少 1 次）算过。
- 钥匙是 `DEEPSEEK_API_KEY`，没有就跳过；模型是 `VIBEVALLEY_EVAL_MODEL`，不填用样例的 `model`。最后打出一张表：样例、模型、过了几次、花了多少 token；没过的每一次打出没过的判断和那一轮的对话。表经 `t.Log` 打出，所以命令带 `-v`：`cd server && go test -tags evals -run TestManagerEvalsLive -count=1 -v ./internal/manager`。

## Alternatives considered

**让另一个模型当裁判，按 `want` 的话判过没过。** 不用写 `expect`，可裁判本身也是一次采样，判断会漂；先用固定的几种判断，等样例多了、固定判断写不出来了再加裁判。

**录下整段 HTTP，原样回放。** 回放的是那次的模型输出，验证不了改了提示以后模型会不会做对；评测要的正是重新采样。

**评测放进默认的 `go test ./...`。** 要连网、要钥匙、要花钱，还会因为模型的随机性时红时绿；离线的那半（样例抓得住错）放进去，联网的那半单独跑。

**并进[先采样，再验收](../../proposed/architecture/2026-10-14-sample-then-verify.md)第 2 步。** 那一步的样本是仓库里的测试，对象是帮工改的代码；管家的错是模型在 harness 里的决策，样本是一段对话，验证要用真模型。

**只按时间找那条输入（第一条不早于这一步的 `managerInput`）。** 提案原来这样写。可 `Later` 送进去的输入是被取走时才写进 `manager.jsonl` 的，不是建好时：一条插队的 `Send` 可能先写进去，时间也更晚，只看时间会拿错；管家没起来时轨迹里有这句话、对话里没有，只看时间会拿到下一轮。加上比字的开头，两种都不会错。

**样例存农场现状。** 现状只在系统提示里，存它要在标记时重拼一遍，拼出来的是标记时的、不是那一轮时的；等提示开头不变以后它在 `input` 里，不用另存。

## Consequences

- 管家的一次错从此有地方放：主人点一下、写一句，样例就在家目录里；修的人有现成的输入和录下的那一轮，不用再从日志里拼。
- 离线的那半跟着 `go test` 跑，改了工具名、写了抓不住错的 `expect` 都马上红；联网的那半要钥匙、花钱，只在改了提示、工具描述或 `internal/agent/brain` 的提示拼法时跑（[verify-manager-evals](../../../skills/verify-manager-evals/SKILL.md)），跑之前问主人。
- 模型的输出是采样：5 次过 4 次也可能是运气；样例多了以后看整体的通过率，不看单个。一个样例约等于管家一轮的 token 乘 N；样例多了以后按改动挑着跑，发版前跑全部。
- `before` 是在旧提示下形成的对话，提示改了以后，对话里管家以前的说法可能和新规矩不一致；重放考的是「在这段历史之后这一轮做不做得对」，接受这个偏差。
- 输入里的农场现状可能只是「变了的行」，全文在更早的输入里；`before` 带着那段对话，重放时模型看到的和当时一样。
- 样例里有主人的私事；进仓库前要去掉，这一步靠人看。
- 还差一个真的样例：现在仓库里只有手写的例子，「至少一个真样例在改提示之前不过、之后过」要等主人标出第一个做错的一轮。
