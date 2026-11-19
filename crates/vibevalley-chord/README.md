# Chord

原生服务在 `/chord/ws` 发布执行治理文档 `space`，接受用户设备身份。初订返回快照。重连到同一份文档时，客户端可从上次修订号续读。修订早于服务端保留的历史时，服务端返回当前快照。文档包含修订号 `rev`、持久执行通知 `inbox` 和待审批工具调用 `approvals`。[治理文档投影](crates/vibevalley-server/src/chord_space.rs)

| 执行命令 | 用途 |
| --- | --- |
| `approval.resolve` | 按任务 ID 批准或拒绝挂起的工具调用。 |
| `budget.raise` | 提高会话的执行预算，返回预算快照。 |

工作台经进程内桥订阅核心帧 `StateFrame`，从帧中读取工单列表和频道未读数。命令行经 HTTP `/api/v1` 读取这些业务数据。[HTTP 入口](crates/vibevalley-http/src/lib.rs) · [进程内桥](crates/vibevalley-bridge/src/hub.rs) · [Chord 注册表](crates/vibevalley-http/src/chord.rs)

## 验证

| 命令 | 验收范围 |
| --- | --- |
| `cargo test --locked -p vibevalley-chord` | 检查快照与增量、慢订阅者、文档退役与重建。在环回 WebSocket 上收发双向调用、分块消息，取消在途调用并断线续订。[文档测试](crates/vibevalley-chord/tests/document.rs) · [链路测试](crates/vibevalley-chord/tests/link.rs) |
| `cargo test --locked -p vibevalley-server --test suite rust_chord_client_approves_a_tool_and_observes_the_durable_issue` | Rust 客户端连接隔离服务，订阅待审批工具调用，确认审批并调整预算。从 `space` 确认审批卡已移除，从工单服务核对工具创建的工单。重开同一数据库后，工单仍只出现一次。[服务端测试](crates/vibevalley-server/tests/orchestrator.rs) |
