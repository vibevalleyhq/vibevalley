# agent

VibeValley 自己的 agent：把模型循环、工具、持久化对话、记忆、技能、定时和压缩装成一个可运行的 agent。管家和 `oarruntime` 都用它；模型与循环分别在 `pkg/ai`、`pkg/agentcore`。

## 对话

`SessionAt` 只读指定的 JSONL 文件；压缩摘要替换之前的上下文，并保留摘要指定的最近消息。读到截断或无法解码的行时跳过该行。它不读取、改写或重命名同名的 `.json` 文件。

## OpenAI 的协议

`ChatCompletions` 是一个 `http.Handler`，让一个有自己对话的 agent 答 OpenAI 的 `chat/completions`：只读最后一条 `user` 的话（历史以 agent 的对话为准），不读 `system`、`tools`，只回字，不填 `usage`。`stream` 为真时回 SSE（`chat.completion.chunk`，最后是空 `delta` 加 `finish_reason: stop` 和 `[DONE]`），否则回一个 `chat.completion`。`model` 交给 `Answerer` 选谁答，没有就回 404 `model_not_found`；出错都用 OpenAI 的 `{"error":{…}}`。请求断开就不再读字。谁能问（路径、钥匙）由挂它的一方管。

## 定时

`MakeSchedules` 把定时写进家目录的 `schedules.json`。添加、取消和到点认领共用一把锁；写临时文件成功后再替换原文件。文件不存在时是空列表；读取失败或内容损坏时，工具返回错误，后台记日志并停止本次修改，原文件保留。

到点先保存认领结果，再唤醒 agent：一次性的定时删除，重复的定时记录本次时间；保存失败不唤醒，下次检查再试。认领成功后进程若在唤醒前退出，这次触发不会补投。离线期间错过多次只唤醒一次。

Cron 支持五段或六段（多出的第一段是秒），使用指定时区，未给时区时用本机时区。按实际时间向前找下一次匹配；夏令时跳过的时刻不执行，回拨中重复的时刻可分别匹配。步长超过字段剩余范围时停止枚举，不让整数加法溢出。

## 检查

`go test ./pkg/agent` 覆盖对话重开、压缩、工具与定时；`reliability_test.go` 覆盖认领写盘失败、损坏文件保留、夏令时切换和极大 cron 步长。
