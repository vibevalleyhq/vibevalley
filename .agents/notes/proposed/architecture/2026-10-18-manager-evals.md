# Agent Note: 管家的错变成评测：主人标出做错的一轮，存成样例，改提示前后用真模型重放

Status: proposed

## Problem

Grok Bot 的内循环：bot 做错一次，就变成一条评测；修 harness、提示或推理，评测过了再上线；每个做得不好的 bot 都变成评测（幻灯片 36:05；[对照 Grok Bot](2026-10-18-always-on-manager.md)第 9 项）。

管家没有这一圈：

- 管家的测试用 `ai.FauxProvider` 扮演模型（`internal/manager/manager_test.go`、`input_test.go`），模型说什么是测试写死的。它们验证的是 harness（输入怎么拼、工具怎么跑、话发到哪），验证不了模型拿到这样的输入会不会做对。
- 黄金数据（`internal/manager/rules_golden_test.go`、`testdata/rules.jsonl.gz`）只覆盖纯函数的规则，比如巡查。
- 改 `managerSystemPrompt`（`internal/manager/manager.go:45-69`）或工具描述时，没有办法知道上次修好的错会不会又出现。
- [先采样，再验收](2026-10-14-sample-then-verify.md)第 2 步说的「故障回流成样本」是帮工改代码的故障，样本是仓库里的测试；管家的错（派错了人、不该说时说了、该问主人时自己合了）不在那里。

做错的那一轮，证据本来都在：`manager.jsonl` 只往后加，压缩也只是追加一行摘要（`pkg/agent/session.go:3`、`66-79`），原文都留着；管家的日志（`session.events`，`internal/protocol/api.go:79-82`）里每一轮有 `user/message`，带 `seq` 和时间（`SessionEvent`，`internal/protocol/shapes.go:534-548`）。`issue.comment` 已经用「日志里的第几步」指一处（`api.go:51-54` 的 `on`）。缺的是把它们存成能重放的样例，和重放它的办法。

## Proposal

### 1. 标出做错的一轮

- 接口：`//vibevalley:route manager.markWrong POST /api/v1/manager/evals`，`//vibevalley:can owner remote`，`ManagerMarkWrong(ctx, body ManagerEvalRequest) (ManagerEval, error)`。`ManagerEvalRequest{On int64, Want string}`：`On` 是管家日志里那一轮的 `user/message` 事件的 `seq`，`Want` 是主人说的「应该怎样」。`ManagerEval{ID string, File string}`。形状写在 `shapes.go`，跑 `go run ./tool/shapegen`。命令行跟着有 `vibevalley manager markWrong`。
- Flutter：管家页的日志（`app/lib/shared/work_log.dart`）在每条 `user/message` 上加一个动作「这一轮做错了」，弹出一个输入框写「应该怎样」，调这个接口；成功后那一步标一个小记号。

### 2. 存成样例

`internal/manager/evals.go`（新文件）：

1. 按 `On` 从管家的日志里找到那条 `user/message`，取它的时间 `t`。
2. 读 `memory.ManagerHome(home)/manager.jsonl` 的全部行（`pkg/agent` 的 `parseLines`，不经 `Replay`，压缩前的原文也在），找第一条 `Timestamp >= t` 的 `managerInput`：`sendInput` 先记轨迹（`manager.go:585`）、后建消息（`manager.go:620`），所以消息的时间不早于事件。
3. `before` = 它之前的那些行经 `Replay` 得到的消息（模型这一轮开始时看到的对话，不含请求前的临时压缩）；`input` = 这条输入；`did` = 从它起到下一条 `managerInput` 之前的消息（管家这一轮调的工具、工具结果、说的话）。
4. 写 `memory.ManagerHome(home)/evals/<id>.json`：

```json
{
  "id": "…", "created": 0, "model": "deepseek-flash", "want": "主人说的应该怎样",
  "memory": "那时 MEMORY.md 的全文", "tools": ["dispatch", "…"],
  "before": [], "input": {}, "did": [],
  "expect": []
}
```

`memory` 取的是标记时的记性，不一定是那一轮时的；在[提示开头不变](2026-10-18-stable-prompt-prefix.md)做完之后，农场现状和时间就在 `input` 里，样例不用另存它们。样例是家目录里的私人文件，不进仓库。

### 3. 期望：几种固定的判断

`expect` 是一个封闭的联合，按 `kind` 分：

| `kind` | 字段 | 过的条件 |
|---|---|---|
| `called` | `tool`，可选 `argContains` | 这一轮调了 `tool`，参数的 JSON 里有 `argContains` |
| `notCalled` | `tool` | 这一轮没调 `tool` |
| `silent` | | 这一轮没有对频道说一个字 |
| `says` | `contains` | 说的话里有 `contains` |
| `saysNot` | `contains` | 说的话里没有 `contains` |

纯函数 `evalCheck(expect []evalExpect, turn []agentcore.AgentMessage) []string` 返回没过的那几条，空就是过了。`switch` 按 `kind` 覆盖每一种，测试遍历成员表。`expect` 由修这个错的人写（开发用的编码 agent 或主人）：把 `want` 的话翻成几条判断。

### 4. 先红：样例要抓得住这次的错（离线，`go test` 里）

- 仓库里放挑过、去掉了私人内容（名字、路径、项目）的样例：`internal/manager/testdata/evals/*.json`。哪些进仓库由主人决定。
- `internal/manager/evals_test.go` 对每个样例检查：能解开；`expect` 不为空；`expect` 里的工具都在 `fm.tools()` 里（改了工具名，样例马上报错）；**对样例里录下的 `did` 跑 `evalCheck` 必须没过**：录下的就是那次的错，判断要抓得住它（[先采样，再验收](2026-10-14-sample-then-verify.md)的「先红了，才算抓住」）。
- 这一步不连网，跟着 `go test ./...` 跑。

### 5. 重放：用真模型，多采几次（联网，单独跑）

- `internal/manager/evals_live_test.go`，开头 `//go:build evals`，默认的 `go test ./...` 不编译它，测试不连网的规矩不变。
- `TestManagerEvalsLive` 对每个样例（仓库里的，加上 `VIBEVALLEY_EVALS` 指向的目录里的，比如家目录的 `manager/evals`）：
  1. 用现在的 `managerSystemPrompt + managerAgentPrompt`、样例的 `memory` 和 `before` 建一个管家的大脑（`vvagent.NewAgent`，`NoSession`）。
  2. 工具用现在的 `fm.tools()`，把每个工具的 `Execute` 换成桩：同名的工具在 `did` 里有结果就按调用的先后给出，没有就返回「（评测里没有这个工具的结果）」。桩不碰农场。
  3. 送进 `input`，跑到这一轮停下，对这一轮的消息跑 `evalCheck`。
  4. 每个样例采 `VIBEVALLEY_EVAL_N` 次（默认 5），过了至少 `N − 1` 次算过。
- 模型和钥匙从环境变量来：`DEEPSEEK_API_KEY`，`VIBEVALLEY_EVAL_MODEL`（不填用样例的 `model`）。输出一张表：样例、过了几次、花了多少 token。
- 命令：`cd server && DEEPSEEK_API_KEY=… go test -tags evals -run TestManagerEvalsLive -count=1 ./internal/manager`。

### 6. 一圈怎么走

1. 主人在管家页标出做错的一轮，写「应该怎样」。
2. 修的人读 `evals/<id>.json`，写 `expect`，去掉私人内容，放进 `testdata/evals/`；跑 `go test ./internal/manager`，确认它红在录下的那一轮上。
3. 改提示、工具描述或 harness。
4. 跑第 5 节的命令：新样例过了，以前的样例也都还过。
5. 提交，提交说明里附上那张表。

第一个样例进仓库时，照 [create-verification-skill](../../../skills/create-verification-skill/SKILL.md) 写一个 `verify-manager-evals`：改了 `managerSystemPrompt`、管家的工具描述或 `pkg/agent` 的提示拼法以后，跑第 5 节，附上那张表。

## Alternatives considered

**让另一个模型当裁判，按 `want` 的话判过没过。** 不用写 `expect`，可裁判本身也是一次采样，判断会漂；先用固定的几种判断，等样例多了、固定判断写不出来了再加裁判。

**录下整段 HTTP，原样回放。** 回放的是那次的模型输出，验证不了改了提示以后模型会不会做对；评测要的正是重新采样。

**评测放进默认的 `go test ./...`。** 要连网、要钥匙、要花钱，还会因为模型的随机性时红时绿；离线的那半（样例抓得住错）放进去，联网的那半单独跑。

**并进[先采样，再验收](2026-10-14-sample-then-verify.md)第 2 步。** 那一步的样本是仓库里的测试，对象是帮工改的代码；管家的错是模型在 harness 里的决策，样本是一段对话，验证要用真模型。

## Acceptance criteria

- 管家页能把一轮标成做错了，家目录的 `manager/evals/` 下出现一个样例，`before`、`input`、`did` 和那一轮对得上；有测试（`FauxProvider` 跑一轮，标它，读回样例）。
- `testdata/evals/` 里的每个样例，录下的 `did` 都过不了它的 `expect`，`go test ./internal/manager` 查这一条。
- `go test -tags evals` 的命令对每个样例输出过了几次；至少一个真样例在改提示之前不过、之后过。
- 有 `verify-manager-evals` 这个 skill。
- `go vet ./... && go test ./...`、`bun run go:deadcode`、`bun run flutter:check`、`bun run docs:verify` 通过。

## Risks

- 模型的输出是采样：5 次过 4 次也可能是运气；样例多了以后看整体的通过率，不看单个。
- `before` 是在旧提示下形成的对话，提示改了以后，对话里管家以前的说法可能和新规矩不一致；重放考的是「在这段历史之后这一轮做不做得对」，接受这个偏差。
- 每跑一次全部样例都花钱：一个样例约等于管家一轮的 token 乘 N；样例多了以后按改动挑着跑，发版前跑全部。
- 样例里有主人的私事；进仓库前要去掉，这一步靠人看。
