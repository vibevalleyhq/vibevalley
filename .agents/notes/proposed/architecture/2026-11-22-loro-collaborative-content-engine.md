# Agent Note: Loro 协作内容引擎：远端同步、流式合批与白板本地副本

Status: proposed

## Problem

Loro 1.18.0 内容平面内核（[crates/core/src/collab/](crates/core/src/collab/mod.rs)）、服务端 CRDT Proxy（[collab.rs](crates/server/src/modules/content/artifact/collab.rs)）、纯内存 `PresenceHub`、`CollabDoc` 持久化 `Cursor` 建议、时间旅行、浅快照压缩与按 `origin` 选择性撤销已上线并沉淀至 [Artifact](docs/subsystems/artifact.md)。目前仍余三项进阶演进未落地：

1. **跨设备与远端 WASM/JS 同步协议未接通**：尚未暴露基于 `loro-crdt` WASM/JS 绑定的断线 Version Vector 差量同步接口。
2. **逐 token 流式写入缺少微批合批窗口**：执行会话逐 token 流式改写 `LoroText` 时，缺少服务端 CRDT Proxy 短时间窗或语义块合批事务节流，高频写入可能放大事务与操作日志开销。
3. **`VvWhiteboard` 本地未持进程内 Loro 副本**：当前交互经进程内桥提交服务端 CRDT Proxy，尚无本地 Loro 副本直写与异步增量同步。

## Proposal

1. **远端差量同步与 `loro-crdt` WASM/JS 兼容**：在保留服务端 CRDT Proxy 与语义化 MCP 工具边界的前提下，为远端设备或跨端协同提供基于 Loro Version Vector 的增量更新导入/导出端点，避免整份快照往返。
2. **CRDT Proxy 微批节流**：在 [collab.rs](crates/server/src/modules/content/artifact/collab.rs) 为高频流式文本写入引入短时间窗或语义块合并提交窗口，降低逐 token 元数据膨胀。
3. **`VvWhiteboard` 本地副本直写**：在原生 `VvWhiteboard`（[whiteboard.rs](crates/rich/src/whiteboard.rs)）内维护进程内 Loro 副本实现拖拽零往返重绘，异步经进程内桥向服务端提交增量字节并按 Version Vector 补齐。

## Alternatives considered

**在控制面、事件流面或代码面也引入 Loro**：任务状态机依赖单点强事务与并发配额，轨迹与消息依赖只追加序号，代码协作依赖 Git 与合并检查；Loro 严格限定在内容平面。

**取消语义化 MCP 工具、让模型直接提交 CRDT 操作码**：模型生成二进制/操作码易错且破坏校验边界，维持服务端 CRDT Proxy 翻译语义工具更可靠。

## Acceptance criteria

- 远端协同支持按 Version Vector 交换增量更新并无冲突收敛。
- 高频流式写块经微批合批后操作日志体积与事务次数显著下降，不丢失 `origin` 与持久化 `Cursor` 建议折叠语义。
- `VvWhiteboard` 本地直写副本与服务端增量同步在断线重连后版本向量一致，完成后更新 [Artifact](docs/subsystems/artifact.md) 并删除本 Note。

## Risks

- 微批合并窗口若跨过多个不同 `origin`，会混淆按会话轮次选择性撤销边界；合批必须严格按同一 `origin` 分桶。
- 本地直写副本与服务端并发写入若发生状态分叉，需确保按 Loro CRDT 更新流与 Version Vector 确定性对账。
