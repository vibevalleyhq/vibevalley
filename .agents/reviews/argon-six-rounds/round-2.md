# 第 2 轮：Task 直接使用正式服务

状态：完成。模型为 `opencode-go/gemini-4-argon`，会话 `ses_e69d7fcd7ffei46xqVUD5nDmzg`。

## 建议与裁决

采纳[Gemini 建议](.agents/reviews/argon-six-rounds/round-2-advice.txt)中的 TaskWork、TaskGit、TaskOptions 和两套假实现消除。不采纳删除所有较窄组装层的附带建议：`worldBelowTasks` 仍被 Artifact 模块测试使用，删除会让不需要计划调度的测试额外构建 Task。

## 执行

- Task（历史实现，已移除） 直接依赖 Issue、Session、Project、Runtime；删除 TaskWork、TaskGit、TaskOptions、选项分支、转发对象和 make 导出。`Task.layer` 是静态层，组装不再接收 task 选项。每次带话仍显式传 `{ kind: "task" }`。
- 删除 FakeWork / FakeGit。原测试迁入真实流程（历史实现，已移除）和纯规则测试（历史实现，已移除）。脚本只模拟农机的输入与回答，文件、提交、worktree、Session、Executor、Assignment 和数据库均走正式实现，不手工施加帮工生命周期事实。
- 拒绝从农机 prompt 边界注入；Task 收到的是 Session 真正包装后的错误。验证原因保留、失败状态、次数和审计事件一致，不再断言假端口独有的裸字符串。
- 恢复测试跨两次服务 Scope，底层脚本保留原生上下文的任务识别；Session 真实中断与恢复。由于中断回报可先于 Task 启动收尾，分别验证真实中断暂停，以及没有会话回报时 comeBack 的精确重启文案。
- 约定和测试入口更新到[计划](docs/subsystems/issue.md)。相对本轮基线，生产文件净减 34 行，迁移后的测试净减 51 行；增加一项启动兜底测试，未以删除覆盖取得净减少。

## 验证

- 计划流程 16 项通过；纯规则、原有 lifecycle 与父子关系流程测试通过。
- `vp check --fix` 通过；`vp run server:check` 16/16 任务成功，719 测试通过、1 真实模型评测跳过（105 文件通过、1 跳过）。日志 `/tmp/vv-six-r2-check.log`、`/tmp/vv-six-r2-server.log`。
- `vp run web:check` 11/11 任务成功；`health:verify` 47 区域棘轮通过；`deadcode`、`docs:verify` 通过。没有修改健康门槛。
- 隔离服务端验收命令：`vpx scripts/verify-server.ts --scripted-helper -- node /tmp/vv-six-r2-acceptance.mjs`。通过 HTTP 创建并派工，`issue.split` 拆出一张要求 `test -f clock.ts` 的子工单；等待 ready，断言子工单 `merged_into_parent` 且有一条真实执行关联，`graph.act(merge)` 合并；最后读取 SSE `/api/v1/state`，父工单与计划均 done、在场会话为 0。
- 验收目录 `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-Gwy6Yu`；`result.json` 为 `code: 0`、`stopped: true`、`cleanupErrors: []`。实际合并了 1 个提交，最终帧 seq 为 49。
- [Gemini 复审](.agents/reviews/argon-six-rounds/round-2-review.txt)：0 项必须修正，核对了覆盖、正式服务边界、触发原因与跨 Scope 恢复。

## 迁移的回归测试

三个名称保留，由计划模块的替身测试迁到 旧计划控制流程测试：

- `regression: a refused manual retry leaves the step failed and returns the delivery refusal`
- `regression: a refused automatic retry fails the step instead of leaving it working`
- `regression: a refused splitter retry abandons the task graph with its reason`

迁移原因是删除生产中的平行测试端口；拒绝经真实农机和 Session 包装，断言保留错误原因、返回与落盘状态的一致性。通知到达与状态落盘分别等待，没有放宽为只检查函数执行过。
