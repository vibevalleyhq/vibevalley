# Chord

原生服务在 `/chord/ws` 发布执行治理文档 `space`，接受用户设备身份。初订返回快照。重连到同一份文档时，客户端可从上次修订号续读。修订早于服务端保留的历史时，服务端返回当前快照。文档包含修订号 `rev`和持久执行通知 `inbox`。[治理文档投影](crates/vibevalley-server/src/chord_space.rs)

| 执行命令 | 用途 |
| --- | --- |
| `budget.raise` | 提高会话的执行预算，返回预算快照。 |

工作台经进程内桥订阅核心帧 `StateFrame`，从帧中读取工单列表和频道未读数。命令行经 HTTP `/api/v1` 读取这些业务数据。[HTTP 入口](crates/vibevalley-http/src/lib.rs) · [进程内桥](crates/vibevalley-bridge/src/hub.rs) · [Chord 注册表](crates/vibevalley-http/src/chord.rs)

工具审批经进程内桥及 HTTP `/api/v1/orchestrator/approval` 处理。[助手工具审批](docs/subsystems/orchestrator.md#工具审批)

## 验证

| 命令 | 验收范围 |
| --- | --- |
| `cargo test --locked -p vibevalley-chord` | 检查快照与增量、慢订阅者、文档退役与重建。在环回 WebSocket 上收发双向调用、分块消息，取消在途调用并断线续订。[文档测试](crates/vibevalley-chord/tests/document.rs) · [链路测试](crates/vibevalley-chord/tests/link.rs) |
| `cargo test --locked -p vibevalley-server --test suite regression_a_stale_approval_cannot_grant_the_next_call_over_http` | 通过 HTTP 处理两次工具审批。用 Rust WebSocket 验证预算调整，重开数据库后核对获批调用只创建一张工单。[服务端测试](crates/vibevalley-server/tests/orchestrator.rs) |
