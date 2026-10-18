# core

本包持有唯一核心状态。`Apply` 折一条事实；`ApplyBatch` 把一组相关事实作为一次状态提交。批次先在局部状态逐条折叠，保留每条事实的效果与状态变化，最后一次替换对读取者可见的状态。

`Transitions` 在同一把锁内取得初始快照和订阅。每个 `Transition` 带该事实自己的 `Before`、`Fact`、`After`：消费晚了也不需要读当前状态猜当时发生了什么，消费者不再另跑一次 `protocol.Reduce`。

批次仍逐条发布原有事实，HTTP 事件格式不变；每条 Transition 的 After 是这条事实的结果，不是整个批次的最终状态。观察者通过 `State` 读取时只会看到完整批次。计划的父子工单用这条提交路径发布。

`go test -race ./internal/core ./internal/game ./internal/task` 验证批次可见性、每条事实的因果状态，以及游戏和计划的消费行为。
