# Resource

`Resource` 是输入流水线的第四层拉取面：为正在运行的管家和帮工会话提供只读、按会话权限裁剪、支持 UTF-16 偏移分页的统一资源读取接口（`resource_read` 工具，对应 `vv://...` URI）。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 解析 `vv://` URI（Trigger、工单、频道、GitHub 评审线程、稿子、记忆、项目），执行会话级读取权限校验 | 各业务实体的写入与状态变更（对应拥有者模块） |
| 大文本按 UTF-16 偏移量分页（`offset` / `limit`）与会话作用域内的 LRU 快照缓存（`TextCache`） | 谁该收到通知或何时唤醒会话（[Mailbox](docs/subsystems/mailbox.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/resource/resource.ts` | `Resource` 服务、权限裁剪与会话级 LRU 快照缓存（`TextCache`） |
| `apps/server/src/tool/resource.ts` | `resource_read` 工具封装 |
| `packages/protocol/src/shapes.ts` | `ResourcePage`（`{ text, totalChars, nextOffset }`）返回契约 |

## 模型和不变量

- **严格只读**：`Resource` 只查询各模块服务与数据库，不修改任何业务表，也不推进消息的消费回执。
- **服务端强制权限边界**：
  - 管家（`orchestrator`）可读全农场资源。
  - 帮工仅可读自身所属工单、父工单、显式前置依赖工单（`blockedBy`）及所在频道的资源；越界访问直接返回 `ResourceError`。
- **快照固定与分页上限**：首次读取（`offset = 0`）生成带字节上限的文本快照存入会话级 `TextCache`，后续分页基于同一快照返回，会话结束时自动回收。

## 怎么走

1. 会话从输入卡片中看到 `vv://trigger/<id>` 或其他 `vv://` URI，按需调用 `resource_read({ uri, offset, limit })`。
2. `Resource.read` 校验该会话对目标 URI 的访问权限，命中或生成快照后返回当前页文本与 `nextOffset`。

## 和谁打交道

- **下层查询模块（`ingress`、`issue`、`channel`、`mailbox`、`session`）**：读取对应实体的完整载荷。
- **工具层（`tool`、`mcp`）**：向管家和帮工暴露 `resource_read` 工具。

## 为什么这样

- **按需拉取替代全量推送，权限由服务端兜底**：投递卡片只带摘要与 `vv://` 指针，避免大段日志或 PR 评论撑爆模型上下文；在读取入口统一核对工单归属，不靠提示词约束访问范围。

## 怎么验证

- `apps/server/src/resource/textCache.test.ts`、`apps/server/src/tool/resource.test.ts`、`apps/server/src/flows/settling.test.ts`：LRU 缓存分页、跨工单越权拦截与 Trigger 载荷读取测试。
