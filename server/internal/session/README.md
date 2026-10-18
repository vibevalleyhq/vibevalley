# session

执行的生命周期、Run、日志、执行目录与农机连接由本包拥有。工单指定要做什么；频道投递输入；它们不自行组合执行的停止、合并、离开和 Run 终结。

## 管家的执行

`AgentExecution` 观察进程内 agent 的有序事件。一个实际 agent loop 对应一个 Run：首次消费输入时开始，agent 结束时终结。同一个 loop 消费多张工单时，`session_run.issue` 保留首张工单，`session_run_issue` 记录所有实际消费的关联。查询任一关联工单，都能读到同一个真实 Run；仍在队列中的输入不提前关联。

日志由执行 owner 写入 `run/start`、输入、思考、回答、工具与 `run/end`；这些事件带同一个 Run ID。模型失败记为 `failed`，停止记为 `interrupted`，成功记为 `completed`。工具执行期间的停止由 agent 结束事件的中断标志给出，不从工具文案猜。

启动失败独立记录一个 failed Run。终结写库失败时，该 Run 进入待终结状态：重试保持原结果，新输入必须等旧 Run 成功终结后才建立新 Run。`CurrentRun` 不把待终结 Run 当成活跃执行；停机也不改写它已经确定的失败结果。工单只在收到成功完成通知后关闭；通知不代替工单自己的写入结果。

输入携带的摘要消息 ID 在真实消费时进入 `Run.Heard`，然后发给频道提交回执。汇报在清除活跃 Run 前捕获 Run ID；消息产生者直接附这份身份，不按时间推断轮次。

管家仍使用自己的频道参与者与核心状态，不作为占地的帮工加入农场。上面的 Run 归属不等于整个管家档案提案已经完成。

## 验证

`go test -race ./internal/session ./internal/manager ./internal/issue`。管家的执行测试覆盖成功、模型失败、启动失败、中断、多个消费输入共享 Run、未消费输入，以及终结写入失败后的恢复隔离。
