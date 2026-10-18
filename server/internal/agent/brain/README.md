# brain

VibeValley 自己的 agent：把模型循环、工具、持久化对话、记忆、技能、定时和压缩装成一个可运行的 agent。管家和 `oarruntime` 都用它；模型与循环分别在 `pkg/ai`、`pkg/agentcore`。

## 事件

`Subscribe` 交付 `agentcore.AgentEvent`：开放的 `Kind() EventKind` 接口。核心事件使用 `MessageStarted`、`MessageUpdated`、`MessageEnded`、`ToolStarted`、`ToolUpdated`、`ToolEnded` 等具体类型；调用方按类型分支读取载荷，不再把字符串 tag 和一组可空字段配对。

本包的 `CompactionStarted`、`CompactionEnded`、`PrefixChanged`、`AgentSettled` 实现同一个接口，核心循环不依赖这些扩展。`MessageUpdated.Delta` 和 `ToolEnded.Result` 是值；压缩结束却没有摘要时，用 `CompactionEnded.Compaction` 为 nil 表达；`CompactionEnded.Usage` 是摘要请求的用量，没请求时为 nil。`AgentSettled.Run` 交付整轮结果。

## 一轮运行的结果

`AgentSettled.Run` 是本轮回执：`Usage` 累计这一轮主循环的模型请求，`Text` 是最近一次已消费的 user/custom 输入之后的最后非空回答，`Aborted`、`Error` 表达最终结果。工具调用、steer 和 follow-up 属于同一轮，直到队列与压缩收尾都结束；新的一轮取得新的 `ID`。`Ask` 直接读取对应回执，不重扫可能已改变的历史。

`Progress()` 随时返回已消费快照：`Current` 含当前未结束模型响应已经报告的 usage，`Lifetime` 累计这个 Agent 实例的各轮，不从重开的对话历史追补。最终模型消息替换对应 partial usage，不重复相加；`ContextTokens` 保持最近模型请求的输入、缓存读取和输出之和。CLI 展示每轮，smith Adapter 展示实例累计，两个调用方不再自己累计模型消息。

`Close` 停止接入、关闭模型循环并消费完已发布的事件，再完成未结算的回执；取消与 Dispose 不会丢掉已经消费的 tokens。模型出错后同轮实际成功，最终结果按最后模型成功结算；工具报错本身不把 Agent 判为失败。失败或停止消息里有文字时，`Ask` 仍返回这些文字，保持原有回复边界。

## 对话

`SessionAt` 只读指定的 JSONL 文件；压缩摘要替换之前的上下文，并保留摘要指定的最近消息。读到截断或无法解码的行时跳过该行。它不读取、改写或重命名同名的 `.json` 文件。

## 压缩

估出的 token 超过 `ContextTokens`（默认 12 万）就在请求前压，一轮停下时把这次的摘要写进对话文件；一轮停下时超过 `IdleFoldAt`（默认预算的八成），就等 `IdleFoldAfter`（默认 10 分钟，小于 0 不等也不压）：其间有输入就不压，到时问 `WakeSoon`，快要被叫醒也不压。在没人时压出的摘要，若这期间对话变了就丢掉。摘要请求带着和平常请求一样的系统提示、工具和全部对话，最后一句是 `SUMMARY_IN_PLACE`，`ToolChoice` 是 `none`；出错、空的或调了工具，退回 `SUMMARY_INSTRUCTIONS` 加拼好的文字的请求。切点（`CutPoint`）在用户的话开头，至少留 `KeepRecent` 条，再往前挪到留下至少 3 条带字的 `assistant` 消息；这样留下的超过预算的一半，或者挪到了头，就不管这一条。

## 提示的开头

系统提示（`instructions`、只有工作目录的 `env`、`skills`、`memory`）在 `NewAgent` 和每次压缩之后由 `refreshPrefix` 拼一次，请求时只读它；时间和别的会变的东西由宿主拼进最新那条输入（`LocaleMinute` 给到分钟的时间，`MemoryNews` 给快照之后 `MEMORY.md` 多了和少了的行，给过的不再给）。每次请求按段和工具定义算 sha256，和上一次请求比；两次之间没有压缩、却有一段变了，发 `PrefixChanged`，`Parts` 是变了的段名。

## 接着做

`Close` 时还在跑的一轮，取消它造出的消息（截断的回答、工具的「已停下」）不写进对话文件，文件停在被打断的地方，和崩溃一样。`SessionUnfinished` 只读对话文件：最后一条是用户的话、`custom` 或没被叫停的工具结果，或者是带工具调用的回答，就是没做完。`Resume(maxAge)` 在大脑闲着、对话没做完、最后一条不比 `maxAge` 旧时接着跑：最后那个回答里没有结果的调用，各补一条失败的结果（`RESUMED_UNKNOWN`）并写进文件。`Stop` 叫停的（最后是 `已停下` 的结果，或被叫停、出错的回答）不接。

## OpenAI 的协议

`ChatCompletions` 是一个 `http.Handler`，让一个有自己对话的 agent 答 OpenAI 的 `chat/completions`：只读最后一条 `user` 的话（历史以 agent 的对话为准），不读 `system`、`tools`，只回字，不填 `usage`。`stream` 为真时回 SSE（`chat.completion.chunk`，最后是空 `delta` 加 `finish_reason: stop` 和 `[DONE]`），否则回一个 `chat.completion`。`model` 交给 `Answerer` 选谁答，没有就回 404 `model_not_found`；出错都用 OpenAI 的 `{"error":{…}}`。请求断开就不再读字。谁能问（路径、钥匙）由挂它的一方管。

## 任务

`AgentOptions.Tasks` 给了一个存储（[task](server/internal/task/engine/README.md)）时，agent 有自己的任务图和三个工具：`task_add` 写图或往图里加（整批收或整批不收）、`task_update` 改一件、`task_graph` 看全图；每次调用都回整张图。服务端给农机 `vibevalley` 的每个会话一个库里的存储（`task_graph`，按会话 id），命令行给内存里的（进程退出就没了），管家和帮手不给。

交给帮手的（`by: helper`）由 `taskrun.go` 推进：等的都做完了就在后台派一个帮手（和 `spawn_agent` 的一样：同样的工具，不能再派，不存对话），同时最多 `MaxHelpers` 个（默认 3）；帮手交回的话写进这件的结果，再作为一条输入（`custom` 的 `task`）交给 agent：闲着开一轮，忙着排到这一轮之后。帮手失败重试一次，再失败标没做成，等模型改了 brief 写回 waiting。`Stop` 连帮手一起叫回，它们的那件退回等着；开机时上次留在「在做」的退回等着，再派一次。不能派帮手的 agent（`NoSubagents`），`by` 只收 `self`。

一轮好好停下（没被叫停、没出错）时还有它自己能做的（ready 的 `self`），交给它一条提醒，开下一轮；图一直没变，提醒到 `MaxNudges` 次（默认 3）就不再提醒，等别的输入。模型每次调任务工具、每个帮手交回都看得到整张图；压缩时，打开的图接在摘要后面（`CompactionOptions.Append`），不进系统提示。图每变一次（模型的工具、帮手交回）发一个 `TasksChanged`；`oarruntime` 把它写成原始记录里的 `vibevalley/tasks` 帧（oar 没有计划这种事件）。

## 定时

`MakeSchedules` 把定时写进家目录的 `schedules.json`。添加、取消和到点认领共用一把锁；写临时文件成功后再替换原文件。文件不存在时是空列表；读取失败或内容损坏时，工具返回错误，后台记日志并停止本次修改，原文件保留。

到点先保存认领结果，再唤醒 agent：一次性的定时删除，重复的定时记录本次时间；保存失败不唤醒，下次检查再试。认领成功后进程若在唤醒前退出，这次触发不会补投。离线期间错过多次只唤醒一次。

Cron 支持五段或六段（多出的第一段是秒），使用指定时区，未给时区时用本机时区。按实际时间向前找下一次匹配；夏令时跳过的时刻不执行，回拨中重复的时刻可分别匹配。步长超过字段剩余范围时停止枚举，不让整数加法溢出。

## 检查

`go test ./internal/agent/brain` 覆盖对话重开、压缩、工具与定时；`reliability_test.go` 覆盖认领写盘失败、损坏文件保留、夏令时切换和极大 cron 步长。核心与本包的 `events_test.go` 覆盖具体事件种类、状态消费者和扩展载荷；`oarruntime/events_test.go` 覆盖运行时映射及压缩的有摘要、无摘要两种结果。

`run_test.go` 覆盖工具多轮、两次运行累计、输入边界、错误恢复与关闭中的 partial usage；`oarruntime/usage_test.go` 覆盖累计口径及实际 Dispose；命令行的 `run_receipt_test.go` 验证只渲染回执。
