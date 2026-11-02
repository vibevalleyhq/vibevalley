# Gemini 4 Argon 架构评审与执行

以 `d376c1b9` 为基线，通过 OpenCode 的 `opencode-go/gemini-4-argon` 获取建议并复审实现。三项建议均已完成核验和落实；其中「删除合并锁内校验」不采纳，保留并发保护。代码在当前工作区，未提交、未推送。

## 建议、取舍与实现

| 建议 | 裁决和机制 | 实现与证据 |
|---|---|---|
| 1：收回 Issue 的 queue、merge、cancel、ran | 采纳。完成、取消和排队经状态机，派工关联只能随真实派工登记；测试不能绕开规则直接写关联 | [Issue](apps/server/src/issue/issue.ts) 的接口和服务对象删除四个成员，内部函数保留。测试经 setStatus 和 hire；历史测试通过真实派工构造在场、离场与缺失记录。约定见[工单](docs/subsystems/issue.md) |
| 1 的附带建议：删除 merge 内的状态检查 | 不采纳。setStatus 的 settledMove 在等待 prLock 之前运行，等待期间状态可能变化；重复读取有并发语义 | [merge.ts](apps/server/src/issue/merge.ts) 保留锁内 statusMove。Gemini 整体复审确认此取舍合理 |
| 2：Task 通过 Session 查询，移除 SessionsInside | 采纳。Task 不把 Core 快照交给会话规则读取；Session 服务只返回声明的接口。禁止所有 roster 导入会误伤纯投影，因此只检查服务同时读取 Core 状态并导入 roster 的组合 | Task（历史实现，已移除） 用 live.sessionOf；[边界检查](apps/server/src/modules.test.ts) 包含正反样例；[Session](apps/server/src/session/session.ts) 删除 Object.assign 后门、SessionsInside、闲置运行器和 make 的无调用导出。约定见[计划](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md) |
| 3：Executor 单独拥有执行状态和资源 | 采纳。只保留窄归属元数据，外部拿查询快照；Session 不保存第二份可变执行引用。未发布或关闭失败的分配继续占槽 | [Executor](apps/server/src/executor/executor.ts) 引入 ExecutionOwner、返回快照；Session 删除 Hand.sess，通过执行器查询，attach 保存恢复号。登记预期失败按 NotRecorded 接住，缺陷和中断统一走退出清理，避免同一次关闭失败重复通知 |

## 测试迁移与回归

| 执行 | 保留或增加的验证 |
|---|---|
| Issue 写入口收拢 | [工单单元测试](apps/server/src/issue/issue.test.ts)、[工单流程](apps/server/src/flows/issue.test.ts)、[工作流程](apps/server/src/flows/work.test.ts) 保留合并通知、git 结果、账本、拒绝、现场保留、排队和取消覆盖。排队由容量限制及 setStatus(todo) 形成 |
| Task 假派工不再写 Assignment | 两项关系测试从 Task 单元测试迁到真实流程（历史实现，已移除）。脚本农机在真实 Session 和 git worktree 上运行，验证父子关系、每个步骤的 Assignment、会话反查工单、分支祖先、拆单者离场与父工单合并；FakeWork 继续覆盖 DAG 调度 |
| Session 内部状态不再泄露 | 工作目录、分支、当前 run 用公开查询；MCP token 从农机实际收到的配置读取，并验证离场后失效；地址验证保留两次真实派活的 URL |
| 进程内轮次 | [recording.ts](apps/server/src/session/recording.ts) 抽出同一份生产持久化，没有复制 SQL 或新增服务。[轮次测试](apps/server/src/session/inProcessRun.test.ts) 保留真实库、日志与终结失败重试；[宿主测试](apps/server/src/session/host.test.ts) 验证 finishedRuns、inputsConsumed 和 runOf 的公开接线。Db.attempt 清单随持久化文件移动更新 |
| 占槽与清理 | [Session 测试](apps/server/src/session/session.test.ts) 经脚本农机缓冲事件，验证接受请求但尚未开始时占槽、拒绝交接与另一张派工，真实事件放行后继续验证；新增登记缺陷加关闭失败只通知一次的回归测试 |
| 执行器快照与 stop | [Executor 回归测试](apps/server/src/executor/executor.test.ts) 保留取消关闭调用方后资源仍被释放、只释放一次的断言；增加快照不随内部变化、未 attached 与 closing 时 stop 不调用底层 abort 的断言 |

## Gemini 原文与复审

| 轮次 | 会话 | 文档 |
|---|---|---|
| 建议 | ses_e69f692eeffeOFFzmA2NpXIwTM | [三项原始建议](.agents/reviews/2026-11-01-argon-architecture.txt) |
| Executor 与 Task 查询复审 | ses_e69ed3f37ffeDvJc3D45c1qoK9 | [第一批复审](.agents/reviews/2026-11-01-argon-executor-followup.txt)：未发现回归，要求补 stop 分支验证；已补 |
| 整体实现复审 | ses_e69e11654ffeDUk9kh5poUfSCU | [最终复审](.agents/reviews/2026-11-01-argon-ports-followup.txt)：正确性、测试覆盖损失、边界、并发风险均无发现 |

最初 `opencode/gemini-4-argon` 返回 HTTP 402「Insufficient account funds」，未产生建议；改用同模型的 opencode-go 通道成功完成。没有以其他模型代替 Gemini。

## 验收证据

| 命令或检查 | 结果 | 日志 |
|---|---|---|
| vp check --fix | 1,032 个文件 lint/类型无错误，格式通过 | /tmp/vibevalley-argon-final-check.log |
| vp run server:check | 16/16 任务成功；服务端 104 文件、717 测试通过，1 文件/1 测试跳过；Effect 诊断与生成查询检查通过 | /tmp/vibevalley-argon-final-server.log |
| vp run web:check | 11/11 任务成功，页面构建通过；既有 chunk 大于 500 kB 提示仍在 | /tmp/vibevalley-argon-all-web.log |
| vp run health:verify | 47 区域棘轮通过，未抬高基线 | /tmp/vibevalley-argon-all-health.log |
| vp run deadcode | 通过；检查发现无调用的 Session.make 导出后已删除并重跑 | /tmp/vibevalley-argon-all-deadcode.log |
| vp run docs:verify、git diff --check | 通过 | /tmp/vibevalley-argon-delivery-docs.log |
| 隔离服务端 | 新建工单→派活→交回→试跑完成→完成并合并；另一张未派活工单取消；最终 StateFrame 中分别为 done/merged、canceled/dismissed，sessions 为 0 | /tmp/vibevalley-argon-final-acceptance.log |

服务端验收通过 `vpx scripts/verify-server.ts --scripted-helper -- sh -c '…'` 执行，使用临时家目录、临时工作目录及脚本农机。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-e4chxl`；`result.json` 为 `code: 0`、`stopped: true`、`cleanupErrors: []`，服务端 stderr 为空。子命令依次调用 issue create、issue work 1、issue status update 1（dry-run 与正式 done）、第二次 issue create、issue status update 2（canceled）、state。

跳过的是 `orchestrator/evals.live.test.ts` 的真实模型评测；本批不修改模型提示或工具描述。当前工作区原有未跟踪的用语提案保持原样。建议、实际实现与检查结果均以本报告及链接文件为准。
