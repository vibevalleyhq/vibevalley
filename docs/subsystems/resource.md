# Resource

## 一句话

给正在跑的会话一个只读、可分页、按权限裁剪的拉取口：`resource_read`，是四层流水线的第四层取数面。

## 管什么，不管什么

- **管**：把 Trigger、消息、工单、频道、稿子、记忆、项目等统一成只读 URI；按会话的权限裁剪；分页和快照缓存。
- **不管**：写这些实体（各自的模块）、谁被叫醒（[信箱](docs/subsystems/mailbox.md)）、工单状态（[工单](docs/subsystems/issue.md)）。

## 在哪

- `apps/server/src/resource/resource.ts` 是服务与会话级 LRU 快照（`TextCache`）；`tool/tool.ts` 是给会话的 `resource_read` 工具。
- 入口是 `Resource.read(session, { uri, offset?, limit? })`；协议形状在 `packages/protocol/src/shapes.ts` 的 `ResourcePage`。

## 模型和不变量

- **只读**：Resource 不写任何业务表；它读各模块的服务和库。
- **权限在读取处**：会话只能读自己相关的 Trigger/工单/频道，越界返回 `ResourceError`。
- **分页有上限**：一次只给一段，`nextOffset` 接着读；缓存按会话作用域回收。

## 怎么走

1. 会话调 `resource_read`，带 URI 和偏移。
2. Resource 解析 URI、检查会话权限，读对应模块/快照。
3. 返回 `text`、`totalChars`、`nextOffset`；大文本分页，不一次全塞进上下文。

## 和谁打交道

- 依赖 Ingress、Issue、Channel、Mailbox、Session 的查询；工具层只做参数解码和转发。
- 页面不直接调它；它只服务会话。

## 为什么这样

- **拉取比推送省上下文。** 会话需要什么读什么，不把整个频道/工单塞进每轮提示；快照缓存避免重复读同一段。
- **权限在服务端。** 不让模型自己判断能读什么；URI 解析和裁剪在 Resource 一处。

## 怎么验证

- `resource/textCache.test.ts`、`tool/resource.test.ts`、`flows/settling.test.ts`。
