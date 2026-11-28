# 爆炸半径支点验证（Blast Radius）

评审跨 `crates/protocol`、`crates/server/src/service/`、数据库迁移或 Rust ↔ TS 桥的小而险改动时，拒收泛泛的影响面长文；只要求定位并证明**「让本次改动安全的唯一核心事实（安全支点）」**。

## 什么时候用

- 改动触及 `crates/protocol/src/contract/`、数据库表结构与迁移（`crates/server/src/db/`）、`crates/server/src/service/`、HTTP `v1` 路由或 Rust ↔ TS 桥（`crates/server/src/gateway/bridge/`、`packages/protocol/`）。
- 改动行数不多但牵动多端或多层，凭肉眼读 diff 无法确认是否漏改调用方。

## 五级确定性阶梯

评审结论必须标明当前证据达到哪一级；跨边界高危改动在升至 **第 4 级或第 5 级** 前不应放行：

| 级别 | 证据形式 | 说明 |
|---|---|---|
| L1 | 肉眼读 diff 推断 | 仅用于提出假设，不能作安全证明 |
| L2 | 全仓静态检索与跨层导航 | `cargo xtask trace <op\|slice>`、`cargo xtask deps`、`git grep` |
| L3 | 编译与类型门禁通过 | `cargo clippy --workspace --all-targets -- -D warnings`、`cargo xtask protocol`、`vp check --deny-warnings` |
| L4 | 真实代码执行覆盖目标路径 | 离线集成/单元测试、协议往返测试、迁移回放或脚本实跑 |
| L5 | 隔离沙箱端到端实证 | `scripts/release/verify-server.ts` 真实接口调用或 `vp run vdp` 真实页面截图 |

## 步骤

1. **一句话写出安全支点事实**：写明「只要事实 X 成立，本次改动就不会破坏任何调用方或存量状态」（例如：「所有读取 `BaseCellValue` 的客户端与投影均按 `_tag` 穷尽解码，且 `"structure/base.json"` 序列化保持 camelCase」）。
2. **排查四类 grep 盲区**：静态符号搜索看不见下面四处，必须逐项核实：
   - **JSON / Wire 序列化**：`#[serde(rename = ...)]`、`#[serde(tag = ...)]`、`#[serde(flatten)]` 与 Zod `schema.ts` 字段名是否一一对齐。
   - **数据库列与迁移**：SQL 字符串、SeaORM 实体列名、`CHECK` 约束、外键级联与 SQLite/PostgreSQL 双库差异。
   - **Rust ↔ TS / MCP 桥**：RPC `op` 名、SSE 切片字段、工具 JSON Schema（`crates/server/assets/tools/`）与 `scripts/gen/` 生成物。
   - **微任务、锁与卸载时序**：异步任务取消、`Drop` / `close_async` 顺序、Loro 并发合并与前端 `effect()` 清理。
3. **把证据推到 L4 / L5**：写或跑最小可执行验证命令证明支点事实成立，把命令与真实输出写进 PR `## Checks` 或工单 `checks`。
