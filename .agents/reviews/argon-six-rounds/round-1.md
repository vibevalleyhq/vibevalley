# 第 1 轮：Runtime 只暴露正式服务接口

状态：完成。模型为 `opencode-go/gemini-4-argon`，会话 `ses_e69d7fcd7ffei46xqVUD5nDmzg`。

## 建议与裁决

[Gemini 建议原文](.agents/reviews/argon-six-rounds/round-1-advice.txt)要求删除 Runtime 的 `Object.assign` 附加属性和 `make` 导出，测试转到公开服务。采纳这部分；不采纳为了方便测试而放宽 `Runtime.layer` 初始化条件的建议，测试装配正式依赖。

## 执行

- [Runtime](apps/server/src/runtime/runtime.ts)：删除 `refreshUsage`、`cached`、`spent`、`setSpent` 四个附加属性和 `make` 导出；缓存、刷新、预算及落盘逻辑保持原样。生产文件净减 7 行。
- [测试](apps/server/src/runtime/runtime.test.ts)：通过 `Layer.build` 在测试 Scope 内构建正式服务，Scope 结束触发真实清理。缓存重建从 Core 公开流观察；用量竞态由后台五分钟轮询和 `usageSoon` 二十秒刷新形成；预算跨日通过 Clock；新增同日关闭后恢复和次日忽略存盘花费的测试。
- 约定写入[档案与农机](docs/subsystems/agent.md)。没有新增生产测试选项或抬高健康基线。

## 验证

- 基线 Runtime 测试 26 项通过；迁移后 27 项通过，原有竞态和预算断言保留。
- `vp check --fix` 通过；`vp run server:check` 的 16/16 任务成功，包含 Effect、生成查询及完整服务端测试。日志 `/tmp/vv-six-r1-check.log`、`/tmp/vv-six-r1-server.log`。
- 隔离服务端命令：`vpx scripts/verify-server.ts --scripted-helper -- sh -c '…'`，依次调用 `runtime list`、`runtime refresh pi`、创建工单、`issue work 1`、完成工单、`state`。证据目录 `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-Z1Xs6b`；`result.json` 为 `code: 0`、`stopped: true`、`cleanupErrors: []`，服务端 stderr 为空。
- [Gemini 复审原文](.agents/reviews/argon-six-rounds/round-1-review.txt)：0 项必须修正；已核对覆盖、Scope 和异步负断言。

## 取舍

本轮消除的是服务接口外的第二套访问方式，测试行数增加以保留真实并发和持久化证据。没有声称净删整个模块或改变业务模型。
