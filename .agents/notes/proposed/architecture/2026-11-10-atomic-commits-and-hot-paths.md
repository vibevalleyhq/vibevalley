# Agent Note: 事务提交尾段原子同步、监听地址就绪门与热路径增量投影

Status: proposed

## Problem

截至 2026-11-10，除已沉淀至 [地基](docs/subsystems/foundation.md) 的概念与契约表面收敛、以及已立项的 [状态先提交，副作用由 worker 在提交之后做](.agents/notes/proposed/architecture/2026-10-22-commit-then-effects.md) 与 [页面的连接接着带上在线状态和工单的增量](.agents/notes/proposed/architecture/2026-10-27-presence-and-entity-deltas.md) 外，服务端与客户端主干还存在 5 处结构性缺陷：

- **写库与内存镜像及 `Core.apply` 缺乏原子提交边界**：[lifecycle.ts](apps/server/src/modules/issue/lifecycle.ts)（第 95–99、156–158、200–202 行）在 `db.attemptTx` 提交后，分步于事务外更新进程内 `Assignments` 索引（`worked.changed`）并经 `bestEffort` 重读数据库调用 `Core.apply`。若任务在 `COMMIT` 后被中断或重读失败，数据库与内存 `worked`、`SpaceState` 即永久分叉直至重启。[mailbox.ts](apps/server/src/modules/mailbox/mailbox.ts)（第 171–195、300–346 行）同样在表外维护 `Deliveries`、`Reach`、`WakeBreaker` 三个可变镜像，靠 `routeLock`、`pumpLock`、`writeLock` 三把独立 `Semaphore` 手工同步。
- **随机端口启动期存在监听回填与恢复派活竞态**：[registry.ts](apps/server/src/modules/session/registry.ts) 第 94 行按初始配置初始化 `mcpEndpoint`（`port: 0` 时为 `:0`）。在 [app.ts](apps/server/src/gateway/http/app.ts) 第 37–62 行，`services` 层先于 `HttpServer` 端口绑定完成构建并执行尾部的 `mailboxReady` 与 `issuesStart`（[services.ts](apps/server/src/services.ts) 第 157–165 行），随后 `ready` 才调用 `Session.setAddress` 与 `Lan.setUpstream`。若启动恢复期间立即拉起帮工（[launch.ts](apps/server/src/modules/session/launch.ts) 第 86、101 行），帮工将拿到未绑定的 `:0/mcp` 地址。
- **HTTP、Tool 与 CLI 三套入口重写工单编排**：[http/handlers/issue.ts](apps/server/src/gateway/http/handlers/issue.ts) 与 [tool/issue.ts](apps/server/src/modules/tool/issue.ts)（第 66–80、212–227、252–313 行）及 [cli/src/commands/issue.ts](apps/cli/src/commands/issue.ts) 各自实现引用解析、默认仓库继承与留言逻辑。`tool/issue.ts` 支持按帮工名字匹配工单及创建时组合 `start` / `draft`，HTTP 入口不支持；`Issue.comment` 允许在无在场帮工时向工单串留言，`tool/issue.ts` 却在无在场帮工时直接拒绝。
- **单连接数据库锁下的 $O(N)$ 排序写放大**：[db.ts](apps/server/src/infra/db.ts) 第 58、145 行固定单连接串行执行事务，而 [lifecycle.ts](apps/server/src/modules/issue/lifecycle.ts) 第 169–175 行的 `place` 每次移动工单均全表读取并在单事务内循环执行 $N$ 次 `UPDATE`，随后在事务外触发 $N$ 次重读与 `Core.apply`，阻塞全局查询。
- **高频阶段跳变下的 $O(S \times I)$ 投影重算与前端全帧深拷贝**：帮工每步工具动作均触发 `sessionPhaseChanged`。在 [reduce.ts](apps/server/src/gateway/projection/reduce.ts) 第 13–15 行，仅改变 `doing` 描述也会因 `sessions` 引用变化重跑全表 `withIssueStatuses`（内部含父子工单递归扫描，见 [status.ts](apps/server/src/modules/issue/status.ts) 第 99–105 行）；[frame.ts](apps/server/src/gateway/projection/frame.ts) 第 17–32 行每 200 ms 无条件重算 `sessions × issues` 查找、全量 `inbox`、农场 `viewOf` 与 `crons` 下次执行文本；客户端 [web/src/infra/frame.ts](apps/web/src/infra/frame.ts) 第 66–73 行每帧对整棵 `StateFrame` 执行 `structuredClone`。

## Proposal

### 1. 事务提交尾段钩子（`Db` Post-Commit Hook）与单出口镜像更新

1. 在 [db.ts](apps/server/src/infra/db.ts) 新增 `inTxCommit`（或为事务块提供 `afterCommit` 登记回调），紧随 SQL `COMMIT` 成功、不经打断地同步执行已登记的内存索引变更与 `Core.apply` 事实折叠；若事务回滚则丢弃回调。
2. 将 [lifecycle.ts](apps/server/src/modules/issue/lifecycle.ts) 的 `worked.changed`、`worked.executed` 与 `publish` 收进提交尾段，直接由写入行构造 `T.Issue` 折叠进 `Core`，消除事务外二次查询与 `bestEffort` 吞错。
3. 将 `Mailbox` 对 `Deliveries` 与 `Reach` 的变更统一收口至 `writtenLocked` 事务出口，逐步将 `routeLock`、`pumpLock`、`writeLock` 收敛为单一有序状态机门面。

### 2. 用监听就绪门（`ServerEndpoint` / `Deferred`）消除启动期 `port: 0` 竞态

1. 在 [app.ts](apps/server/src/gateway/http/app.ts) 装配顺序中，确保 `HttpServer` 完成端口绑定并确定 `127.0.0.1:<port>` 后，再放行依赖本地回环地址的启动恢复阶段，或提供持有 `Deferred<string>` 的回环地址服务供 `Session`（`/mcp`）与 `Lan`（上游转发）按需等待。
2. 废弃命令式可变方法 `Session.setAddress` 与 `Lan.setUpstream`（测试使用固定地址初始化层），从根源消除未绑定端口即向帮工注入 `:0/mcp` 的时序窗口。

### 3. 下沉工单用例至 `Issue` 深模块，薄化三端入口

1. 将「按编号、ID 或在场帮工名字解析工单引用」统一收进 `Issue.idOf`，删除 [tool/issue.ts](apps/server/src/modules/tool/issue.ts) 私有的 `findIssue`。
2. 在 `Issue` 服务内统一提供带频道默认仓库与父单继承的创建编排（含可选 `start` 与 `refine` 一步执行）及带 `Actor` 身份的工单留言；`http/handlers/issue.ts`、`tool/issue.ts` 与 `apps/cli` 仅做入参解码与输出文本/JSON 格式化。

### 4. 看板分数阶排序（Fractional Indexing）替代全表重排

1. 将未派发工单的 `rank` 调整改为计算前后相邻工单的中间序值（双精度中值或分数阶键，仅当相邻间距耗尽精度时在单事务内局部重平衡），单次移动固定执行 1 条 `UPDATE` 与 1 次 `Core.apply`。

### 5. 投影层脏域短路与引用记忆化，去除前端冗余深拷贝

1. **跳过纯 `doing` 动作的全表工单重算**：在 [reduce.ts](apps/server/src/gateway/projection/reduce.ts) 中判断 `sessionPhaseChanged` 是否改变影响工单状态与阶段的字段（`phase._tag`、`phase.quietSince`、`phase.retry`）；仅更新 `doing` 或 `spent` 时直接返回更新后的 `sessions` 与 `plays`，不触发 `withIssueStatuses`。
2. **预建工单索引与子视图单槽记忆化**：在 [status.ts](apps/server/src/modules/issue/status.ts) 的 `withIssueStatuses`、[items.ts](apps/server/src/modules/inbox/items.ts) 的 `inbox`、[view.ts](apps/server/src/modules/game/view.ts) 的 `viewOf` 与 [frame.ts](apps/server/src/gateway/projection/frame.ts) 的 `frameOf` 中，用单次 `Map` 索引替代嵌套 `state.issues.find` / `filter` 循环；对 `inbox`、`viewOf`（按 `issues`、`sessions`、`plays`、`commits`、`progress`、`crons`、`chat?.userMentions` 引用）及 `crons` 文本（按 `state.crons` 引用加当前分钟桶）做单槽记忆化。
3. **客户端按需克隆**：在 [web/src/infra/frame.ts](apps/web/src/infra/frame.ts) 中保持 `frames.get().frame` 为网络解码出的不可变树，仅在首次初始化 Solid store 或 `reconcile` 需要隔离可变代理时做最小复制，配合 [页面的连接接着带上在线状态和工单的增量](.agents/notes/proposed/architecture/2026-10-27-presence-and-entity-deltas.md) 合流实时通道。

## Alternatives considered

- **将内存状态完全改为每次从数据库现查，取消 `Core` 内存折叠**：帮工流式事件与页面 200 ms 帧推送频率高，每次出帧查单连接 PGlite 会占满 I/O 锁；保留内存投影并用 `uninterruptibleMask` 提交尾段对齐数据库即可兼顾一致性与吞吐。
- **在 `projection/frame.ts` 引入第三方响应式计算图库**：`StateFrame` 的根集合仅有 `issues`、`sessions`、`plays`、`crons`、`chat`、`commits`、`progress` 七项，且 `reduce.ts` 已保证未变集合保持原引用；几十行纯引用相等（`===`）单槽缓存即可零依赖达成同等跳过效果。
- **保留 `tool/issue.ts` 独立编排以维持提示词定制灵活性**：工具层仍可保留专属的自然语言回执模板（`prompts.ts`），但引用解析规则、默认仓库推导与留言落点属于领域不变量，分叉只会制造「助手说的和按钮点的不一样」的隐蔽缺陷。

## Acceptance criteria

- [db.ts](apps/server/src/infra/db.ts) 提供不可中断事务提交尾段机制，`issue` 与 `mailbox` 的内存镜像更新不再裸露在可中断事务外。
- `port: 0` 启动时，恢复阶段派发的帮工始终拿到真实绑定的 `127.0.0.1:<port>/mcp` 地址。
- `tool/issue.ts` 与 `http/handlers/issue.ts` 共用同一套 `Issue` 引用解析、创建继承与留言规则。
- `place` 移动单张工单在常规情况下仅执行 1 次数据库写查询与 1 次 `issueChanged` 事实折叠。
- 帮工高频发送 `sessionPhaseChanged`（仅 `doing` 变化）时，`reduce` 不重跑 `withIssueStatuses`，`frameOf` 复用未变的 `inbox` 与 `crons` 投影；全部现有单元与流程测试通过。

## Risks

- **`frameOf` 单槽缓存受语言切换或跨分钟时间推进影响**：`whenText`、`actionText`、`badge` 依赖当前界面语言，`nextText` 依赖当前分钟。记忆化键必须同时包含当前语言标识（`locale`）以及针对 `crons` 的分钟级时间戳桶（`Math.floor(Date.now() / 60_000)`），防止切语言或跨分钟后返回过期文案。
- **`uninterruptibleMask` 提交尾段阻塞**：提交尾段回调只能执行纯内存数据结构更新与非阻塞的 `Core.apply`，严禁在尾段内发起新的数据库查询或子进程 I/O，否则会延长单连接事务锁持有时间。
