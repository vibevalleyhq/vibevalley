# manager

管家接收频道、工单、巡查、计划消息和语音输入，把它们交给 `internal/agent/brain`，从 [tool](server/internal/tool/README.md) 拿工具，并把回答送回来源。

## 输入与回复

每条输入携带频道、主人选定的帮工、是否静默和本次语音输出流。元数据跟输入一起进入 agent 原有的 steering 或 follow-up 队列；时间、农场现状（全文或变了的行，`situation.go`）、记性的更新、农场动态和本次用户指令合成一条输入提交，第一轮模型请求同时读到它们。管家忙着时提交的输入可能排在后提交的之后，所以带全文，下一条也带全文。入队不会改变正在回答的频道。

输出按 agent 消息事件的顺序切换上下文；工具读取当前已消费输入的上下文，确定在哪个频道派活、优先用哪个档案。同轮消费多条输入时使用最后消费的一条的上下文，队列优先级和合并策略由 `internal/agent/brain` 决定。频道输入按消息 id 关联主人选定的档案。

电话（`Call`）和本机的 `/v1/chat/completions`（`Answerer`，当作田头里的话）共用一个输出流：新的请求关闭前一个输出流；它的流只在对应输入被消费后接收回答。语音请求取消时关闭自己的流，不接收后续输出。

## Run 与日志

管家只投递带来源的输入并转送有序 agent 事件；Run、日志边界和终结重试由 [session](server/internal/session/README.md) 拥有。排队不等于消费，未消费的工单不会被上一轮一起关闭；模型失败和中断也不会被当成完成。

摘要读取不提交已读。摘要 ID 跟本次输入走，真正消费并记入 Run 后，执行 owner 才通知频道提交回执；取消未消费的排队输入不会丢掉摘要。

## 验证

`go test -race ./internal/manager`。`input_test.go` 用模型响应屏障验证后入队频道不抢当前回复及档案，以及新语音流不接收前一条聊天的回答。

## 评测

主人标出的做错的一轮（`MarkWrong`，`evals.go`）存在家目录的 `manager/evals/<id>.json`。挑过、去掉私人内容、写了 `expect` 的放进 `testdata/evals/`：`evals_test.go` 查每个样例录下的那一轮过不了它的 `expect`（跟着 `go test`）；`evals_live_test.go`（`-tags evals`）用真模型把每个样例重放 `VIBEVALLEY_EVAL_N` 次（默认 5），至少过 `N − 1` 次算过。`expect` 的几种判断和 `evalCheck` 在 `evals_check_test.go`，只有测试用。`testdata/evals/think-before-dispatch.json` 是照着样例的格式手写的例子，不是录下的。
