# Agent Note: 邮箱收成一把锁、删掉回填地址的方法、页面不再深拷贝每一帧

Status: proposed

## Problem

提交尾段（`db.afterCommit`）、先定端口再组装服务、`Issue.idOf`、看板单行排序、`doing` 短路与出帧缓存已经在代码里（见 [核心状态和接口](docs/subsystems/core.md)、[工单](docs/subsystems/issue.md)）。还剩三处：

- **邮箱靠三把锁手工同步**：[mailbox.ts](apps/server/src/modules/session/mailbox.ts) 用 `routeLock`、`pumpLock`、`writeLock` 三个独立的 `Semaphore` 守着表外的 `Deliveries`（[deliveries.ts](apps/server/src/modules/session/deliveries.ts)）和熔断拦住的会话（`Reach`、`WakeBreaker` 已搬到观察层的 [brakes.ts](apps/server/src/modules/watch/brakes.ts)）。镜像的更新已经挂在 `db.afterCommit` 上，但路由、投递泵和写入各拿各的锁，`withdrawDispatches` 还在 `writeLock` 外另开事务；三把锁之间的先后只靠调用点自己遵守。
- **回填地址的方法成了空转**：[app.ts](apps/server/src/gateway/http/app.ts) 已经先绑端口、用真实端口组装服务，[registry.ts](apps/server/src/modules/session/registry.ts) 的 `mcpEndpoint` 和 [lan.ts](apps/server/src/gateway/lan/lan.ts) 的 `upstream` 一开始就是对的地址；随后的 `Session.setAddress`、`Lan.setUpstream` 只是写回同一个值。它们留着可变的入口，测试（`flows/reach.test.ts`、`flows/worker-cli.test.ts`）还在用它改地址。
- **页面每帧深拷贝整棵 `StateFrame`**：[apps/web/src/infra/frame.ts](apps/web/src/infra/frame.ts) 的 `createFrames` 在建 store 和每次 `reconcile` 前对整帧 `structuredClone`，帮工每步动作都会让 200ms 一帧的拷贝走一遍全部工单、会话和频道。

## Proposal

1. **邮箱收成一个有序的门**：把 `Deliveries` 与 `Reach` 的变更都收进 `writtenLocked` 的事务出口，路由和投递泵排在同一把锁后面；`withdrawDispatches` 也走这把锁。做完删掉 `routeLock`、`pumpLock`。
2. **删掉 `setAddress`、`setUpstream`**：地址只由组装时的配置给出；两个流程测试改成用固定端口的配置组装。
3. **页面按需复制**：`frames.get().frame` 保持网络解码出的不可变树，只在第一次建 store 时复制；`reconcile` 改为直接读新帧（它只读来源、写进 store），去掉每帧的 `structuredClone`。

## Alternatives considered

- **每次出帧都从库里现查，去掉内存投影**：帮工的流式事件和 200ms 一帧的推送频率高，单连接的 PGlite 会被出帧占满；保留内存投影、用提交尾段对齐库即可。
- **邮箱保留三把锁，只补注释写清先后**：先后靠人记，下一处新调用点照样可能反着拿锁；收成一把锁后不存在先后。

## Acceptance criteria

- [mailbox.ts](apps/server/src/modules/session/mailbox.ts) 只剩一把锁，`Deliveries`、`Reach` 的每次变更都在它的事务出口里；现有邮箱和流程测试通过。
- `Session` 与 `Lan` 的接口里没有 `setAddress`、`setUpstream`；`port: 0` 启动时恢复的帮工拿到真实的 `127.0.0.1:<port>/mcp`。
- [apps/web/src/infra/frame.ts](apps/web/src/infra/frame.ts) 只在建 store 时复制一次；`vp run web:check` 通过。

## Risks

- **`reconcile` 直接读新帧**：要确认 Solid 2 的 `reconcile` 不把来源对象挂进 store；若挂进去，后一帧与前一帧比较的代码会看到被改过的对象。用页面的组件测试对比前后两帧的引用验证。
- **一把锁拉长等待**：投递泵和路由排到同一把锁后，一次慢的路由会推迟投递；锁里只放库写和内存更新，不放启动帮工这类慢活。
