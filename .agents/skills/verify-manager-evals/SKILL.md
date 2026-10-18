---
name: verify-manager-evals
description: 改了管家的提示（server/internal/manager/manager.go 的 managerSystemPrompt、managerAgentPrompt）、管家的工具和它们的描述（server/internal/tool）、或 server/internal/agent/brain 拼提示和压缩的办法之后，用真的 DeepSeek 模型把 server/internal/manager/testdata/evals 里的样例各重放 5 次，证明以前修好的错没有回来、新修的错修好了。也用在：把主人标出的做错的一轮（家目录的 manager/evals/）做成样例进仓库；主人说「跑一下管家的评测」「管家又犯这个错了」「改了提示看看有没有变坏」。
---

# 验证管家的评测

管家的测试用 `FauxProvider` 扮演模型，只验证 harness。模型拿到这样的输入会不会做对，要用真模型重放主人标出的那些轮：每个样例采 5 次，至少过 4 次算过。设计和理由见 [管家的错变成评测](../../notes/implemented/architecture/2026-10-18-manager-evals.md)。

## 什么时候用

- 改了 `managerSystemPrompt`、`managerAgentPrompt`、`internal/tool` 里管家工具的名字、描述、参数或顺序。
- 改了 `server/internal/agent/brain` 里系统提示怎么拼、对话怎么压缩（`agent.go` 的 `systemPrompt`、`compaction.go`）。
- 往 `server/internal/manager/testdata/evals/` 加了样例。

不用它：只改了管家的 harness（输入怎么排队、话发到哪个频道、工具怎么调农场），`go test ./internal/manager` 就够。

重放连网、花钱（一个样例约等于管家一轮的 token 乘 5），**跑之前先问主人**。没有钥匙或主人没同意时，只做「准备」的第 1 步，并在汇报里写明在线的那半没跑。

## 准备

1. 先过离线的检查：每个样例能解开、`expect` 不空、写到的工具管家都有、录下的那一轮过不了它的 `expect`。

   ```bash
   cd server && go vet ./... && go vet -tags evals ./... && go test ./internal/manager
   ```

2. 要加新样例时，从家目录拿主人标出的那一轮：

   ```bash
   ls ~/.vibevalley/manager/evals/        # macOS 应用在 ~/Library/Application Support/vibevalley/manager/evals/
   ```

   读 `want`，在 `expect` 里写几条判断（`kind` 只有 `called`、`notCalled`、`silent`、`says`、`saysNot`，字段见 `server/internal/manager/evals.go` 的 `evalExpect`）。去掉私人的内容（名字、路径、项目、钥匙），文件名起成一句话的英文（`think-before-dispatch.json`），放进 `server/internal/manager/testdata/evals/`，再跑第 1 步：它要报这个样例「红」以外的错就修样例；它不报，说明录下的那一轮确实过不了 `expect`。

3. 钥匙在环境变量里：`DEEPSEEK_API_KEY`。不要把它写进命令、日志或汇报。

## 步骤

1. 在**改之前**的代码上跑一遍，记下表：

   ```bash
   cd server && go test -tags evals -run TestManagerEvalsLive -count=1 -v ./internal/manager
   ```

   最后打出一张表：`| case | model | passed | tokens |`，每个样例一行，`passed` 是 `过了几次/5`。没过的每一次都打出 `missed` 和那一轮的对话。新样例在改之前应当不过。

2. 改提示、工具描述或 harness。
3. 再跑第 1 步的命令。新样例过了（至少 4/5），以前的样例也都还过，`--- PASS: TestManagerEvalsLive`。
4. 只想看几个样例、换模型或少采几次省钱：

   ```bash
   cd server && VIBEVALLEY_EVAL_N=2 VIBEVALLEY_EVAL_MODEL=deepseek-flash go test -tags evals -run TestManagerEvalsLive -count=1 -v ./internal/manager
   ```

   `VIBEVALLEY_EVALS=<目录>` 把那个目录里的样例也一起跑（比如家目录的 `manager/evals`，还没写 `expect` 的会跳过）。

## 证据

说「验证过了」时，给主人看：

- 第 1 步和第 3 步的两张表，提交说明里也附上第 3 步的那张。
- 第 3 步的 `--- PASS: TestManagerEvalsLive` 和 `ok  vibevalley/internal/manager`。
- 有没过的样例时，它的 `missed` 和那一轮的对话，说明为什么接受（或者接着改）。

## 出错时

- **`--- SKIP: TestManagerEvalsLive … DEEPSEEK_API_KEY is not set`**：环境里没有钥匙。问主人要，不要自己去找主人的配置文件。
- **`the model: …`**：DeepSeek 返回了错（钥匙不对、余额不够、限流）。照原话告诉主人。
- **`the turn took too long`**：一轮超过 5 分钟，多半是网络。再跑一次；还这样就告诉主人。
- **一个样例时过时不过（比如 3/5）**：模型在两种做法之间摇摆。看没过的几次的对话，改提示让规矩更明确；不要为了过而放宽 `expect`。
- **离线的检查报 `the manager has no tool`**：工具改了名，样例里的 `expect` 跟着改。
- **离线的检查报 `passes its expect`**：`expect` 抓不住录下的错，重写它。

## 收拾

重放用的是临时目录，跑完自己删；不起服务端、不留进程，没有要收拾的。
