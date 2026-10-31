# Agent Note: Effect 运行时：按取消、回收与延迟证据改造

Status: proposed

## Problem

本轮按主人指定的 `0e8bb950` 基线核查与收敛；`f527d936` 只用于核对原提案的出处，不将它新增的接口移植到本轮。验证结果见本篇的核查结论。

## Proposal

| 候选 | 需要证明的行为 | 实施边界 |
|---|---|---|
| `bounded` 慢订阅 | 队列溢出且下游结束后，上游是否仍消费；同时检查 `Stream.unwrap` 与 `forkScoped` 的 Scope | 未复现前不称 Fiber 泄漏；先做释放探针测试 |
| SDK 回调进入 Effect | 关闭后是否还能入队或写状态；队列溢出如何交代 | 保留必要的运行时桥，绑定所有权、顺序和容量 |
| Core 多订阅计算 | 一、二、多个客户端的拼帧次数与延迟 | 仅在收益成立时共享拼帧；保留首次快照与每位订阅者的效果语义 |
| 同步写盘 | 代表会话负载下事件循环延迟及写盘耗时 | 先一个持久化接缝；保留顺序、原子替换与关闭 flush |
| 出站 HTTP | 调用取消能否终止请求、超时与重试是否可测试 | 按供应商适配器迁移，测试取消、状态码与解码 |
| 缓存和连接池 | 去重、失效、配置代际切换及旧结果回写 | 比较原生 Cache/RcMap 的语义后再替换 |
| 双阶段初始化 | 未初始化对象是否可能被外部使用 | 若成立，用一次构造返回就绪对象；不以 Class 数量验收 |

`let`、`Effect.result`、串行循环、`addFinalizer` 和受 Scope 管理的 runtime 桥均不直接计为缺陷。`SynchronizedRef` 只用于需要跨异步步骤互斥的状态；`Effect.forEach` 不会减少 SQL 查询次数。

实施顺序见[治理范围](.agents/notes/proposed/process/2026-10-30-code-quality-ratchets-and-boundaries.md)。

## 核查结论

| 候选 | 最终处置与证据 |
|---|---|
| bounded | 保留。现有慢订阅测试在外层 Scope 关闭前验证源 finalizer 执行一次，泄漏指控未成立 |
| SDK 回调 | 保留必要的桥。Connector sealed/signal 与晚到消息测试已有；不把合法 makeRuntime 调用计作缺陷 |
| 出站取消 | 修复 pi 余额、聊天预览、MOSS 状态查询的 AbortSignal 传播。三个受控 fetch 探针中调用取消后请求均 aborted；Runtime 测试新增取消断言，原有超时保留。oar accountUsage 接口只支持 timeoutMs，不伪造取消参数 |
| 代际 | Runtime/Sources 已有旧结果、退休取消测试；修复 Nowledge 内部旧请求失败误清新连接。新增 source-lifetime 回归使四次调用使用连接 [1,1,2,2]，连接数为 2 |
| 双阶段对象 | 不重写。Brain 私有构造，make 等待 open；Host 对 pending build、close、迟到结果有测试 |
| 共享拼帧 | 不引入。6 会话、50 工单、3 客户端、100 轮，拼帧+序列化 p95 0.28ms、最大 2.87ms；保留独立首次快照与效果窗口 |
| 异步持久化 | 不引入。上述状态每份约 19.6KB，六份同步写盘 p95 1.48ms、最大 1.83ms；现有顺序、原子替换与关闭 flush 保留 |

测量与取消输出由 `/tmp/vv-frame-write-bench.mts`、`/tmp/vv-review-outbound-cancel.sh`、`/tmp/vv-review-nowledge-race.sh` 重放。合成负载不能证明所有机器与数据规模都无瓶颈，只足以撤销本轮未经测量的全仓替换。

## Alternatives considered

**全仓清零 Unsafe、Class、同步 API。** 使用次数无法区分必要边界与错误所有权；一次改写会混合取消、排序与持久化行为。

**统一把 SDK 回调改成无界队列。** 会把阻塞换成无界内存增长，且改变事件处理时序。

## Acceptance criteria

- 每项先固定触发顺序或代表负载，证明修改解决的行为。
- 取消与关闭测试检查后台工作、外部句柄和最后一次持久化。
- 性能改动报告测量，不以组合子数量或调用清零作为完成条件。

## Risks

共享流可能丢首次快照或重复播放效果；异步写盘可能发生旧快照覆盖新快照。两者应独立提交和验证。
