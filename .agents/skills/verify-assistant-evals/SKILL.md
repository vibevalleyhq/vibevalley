---
name: verify-assistant-evals
description: 改了管家的提示（apps/server/src/assistant/assistant.ts 的 systemPrompt、agentPrompt）、管家的工具和它们的描述（apps/server/src/tool）、或 apps/server/src/agent/brain 拼提示和压缩的办法之后，用真的 DeepSeek 模型把 apps/server/src/assistant/testdata/evals 里的样例各重放 5 次，证明以前修好的错没有回来、新修的错修好了。也用在：把主人标出的做错的一轮（家目录的 assistant/evals/）做成样例进仓库；主人说「跑一下管家的评测」「管家又犯这个错了」「改了提示看看有没有变坏」。
---

# 验证管家的评测

管家的测试用 pi-ai 的假模型，只验证 harness。模型拿到这样的输入会不会做对，要用真模型重放主人标出的那些轮：每个样例采 5 次，至少过 4 次算过。设计和理由见 [管家的错变成评测](docs/subsystems/assistant.md)。

## 什么时候用

- 改了 `systemPrompt`、`agentPrompt`、`apps/server/src/tool` 里管家工具的名字、描述、参数或顺序。
- 改了 `apps/server/src/agent/brain` 里系统提示怎么拼、对话怎么压缩（`agent.ts`、`prefix.ts`、`compaction.ts`）。
- 往 `apps/server/src/assistant/testdata/evals/` 加了样例。

不用它：只改了管家的 harness（输入怎么排队、话发到哪个频道、工具怎么调农场），`cd apps/server && npx vp test run src/assistant` 就够。

重放连网、花钱（一个样例约等于管家一轮的 token 乘 5），**跑之前先问主人**。没有钥匙或主人没同意时，只做「准备」的第 1 步，并在汇报里写明在线的那半没跑。

## 准备

1. 先过离线的检查：每个样例能解开、`expect` 不空、每条 `expect` 写全了它那一种要的字段、录下的那一轮过不了它的 `expect`。

   ```bash
   cd apps/server && bun run check && npx vp test run src/assistant/evals.test.ts
   ```

2. 要加新样例时，从家目录拿主人标出的那一轮：

   ```bash
   ls ~/.vibevalley/assistant/evals/
   ```

   读 `want`，在 `expect` 里写几条判断（`kind` 只有 `called`、`notCalled`、`silent`、`says`、`saysNot`，字段见 `apps/server/src/assistant/evals.ts` 的 `Expect`）。去掉私人的内容（名字、路径、项目、钥匙），文件名起成一句话的英文（`think-before-dispatch.json`），放进 `apps/server/src/assistant/testdata/evals/`，再跑第 1 步：它报这个样例的 `missed` 是 `false`，说明 `expect` 抓不住录下的错，重写它。

3. 钥匙在环境变量里：`DEEPSEEK_API_KEY`。不要把它写进命令、日志或汇报。

## 步骤

1. 在**改之前**的代码上跑一遍，记下表：

   ```bash
   cd apps/server && npm run evals
   ```

   最后打出一张表：`| case | model | passed | tokens |`，每个样例一行，`passed` 是 `过了几次/5`。没过的每一次都打出 `missed` 和那一轮的对话。新样例在改之前应当不过。

2. 改提示、工具描述或 harness。
3. 再跑第 1 步的命令。新样例过了（至少 4/5），以前的样例也都还过，vitest 报 `pass on the real model` 通过。
4. 只想少采几次省钱、换模型、或把家目录里的样例也跑上：

   ```bash
   cd apps/server && VIBEVALLEY_EVAL_N=2 VIBEVALLEY_EVAL_MODEL=deepseek-flash VIBEVALLEY_EVALS=~/.vibevalley/assistant/evals npm run evals
   ```

   还没写 `expect` 的样例会跳过（`no expect yet, skipped`）。

## 证据

说「验证过了」时，给主人看：

- 第 1 步和第 3 步的两张表，提交说明里也附上第 3 步的那张。
- 第 3 步 vitest 的通过行。
- 有没过的样例时，它的 `missed` 和那一轮的对话，说明为什么接受（或者接着改）。

## 出错时

- **测试被跳过**：环境里没有 `DEEPSEEK_API_KEY`，或没经 `npm run evals`（它设 `VIBEVALLEY_EVALS_LIVE=1`）。钥匙问主人要，不要自己去找主人的配置文件。
- **模型报错**：DeepSeek 返回了错（钥匙不对、余额不够、限流）。照原话告诉主人。
- **`the turn took too long`**：一轮超过 5 分钟，多半是网络。再跑一次；还这样就告诉主人。
- **一个样例时过时不过（比如 3/5）**：模型在两种做法之间摇摆。看没过的几次的对话，改提示让规矩更明确；不要为了过而放宽 `expect`。
- **离线的检查报某条 `expect` 缺字段**：照 `problemOf` 说的补上；工具改了名，样例里的 `tool` 跟着改。

## 收拾

重放用的是临时目录，跑完自己删；不起服务端、不留进程，没有要收拾的。
