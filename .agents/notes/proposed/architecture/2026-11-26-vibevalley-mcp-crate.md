# Agent Note: 独立协议包 `vibevalley-mcp`（Stateless Streamable HTTP + SEP-2640 Skills）

Status: proposed

## Problem

在拆出独立协议包之前，VibeValley 的 MCP 实现分散在两处：

- [crates/server/src/agent/mcp/mod.rs](crates/server/src/agent/mcp/mod.rs) 与 [crates/server/src/gateway/http/server.rs](crates/server/src/gateway/http/server.rs) 手写 JSON-RPC 2.0 解析、`initialize` 握手、工具/资源分发与密钥脱敏；仅支持旧版有状态会话（`2025-06-18`），缺少 SEP-2575 `server/discover` 与 `_meta` 自描述无状态调用，也未校验 SEP-2243 路由头（`MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name`）。
- [crates/cli/src/domains/mcp.rs](crates/cli/src/domains/mcp.rs) 复制了另一套 JSON-RPC 2.0 结构体、错误码常量、脱敏逻辑与 stdio 行循环，难以与服务端同步演进，也没有共享的 `McpServerConfig` 契约供 OAR 层配置外部编码 agent 使用。
- `crates/server/assets/artifact/types/` 下 12 类作品的渐进披露指南（`SKILL.md` 与 `references/*.md`）只能通过内部工具 `artifact_type_read` 访问，尚未按 SEP-2640 Skills over MCP（`skill://`、`skills/list`、`skills/get`）暴露给外部与执行会话客户端。

## Proposal

新建纯协议 workspace crate `crates/mcp`（包名 `vibevalley-mcp`），聚焦纯粹的 MCP 协议、传输层、Skills 规范、脱敏与配置类型，**严格不包含任何编码 agent 探测或安装逻辑**（后者归属 OAR `crates/runtime/src/oar/`）。

### 模块划分

| 模块 | 职责 |
|---|---|
| `protocol.rs` | `PROTOCOL_STATELESS`（`2026-07-28`）、`PROTOCOL_LEGACY`（`2025-06-18`）、`SUPPORTED_PROTOCOLS`、JSON-RPC 错误码（含 `-32020` `HEADER_MISMATCH`）与强类型 MCP 载荷（`RpcRequest`/`RpcResponse`/`RequestMeta`/`ToolDef`/`ToolCallResult`/`ContentBlock`/`ResourceDef`/`ServerCapabilities`） |
| `stateless.rs` | 窄异步 `McpHandler` trait、SEP-2575 `server/discover` 与 `_meta` 免握手直调、旧版 `initialize`/`notifications/initialized`/`ping` 兼容、SEP-2243 `HttpHeaders` 校验与响应头生成 |
| `skills.rs` | SEP-2640 `SkillDef`/`SkillDocument`/`SkillCatalog`、`skills/list`、`skills/get`、`skill://` 资源读取及嵌入式/目录式 `SKILL.md` 加载器（带路径穿越拦截） |
| `stdio.rs` | 基于 `McpHandler` 的异步换行分隔 JSON-RPC 2.0 stdio 运行器（`serve_io`、`serve_stdio`） |
| `config.rs` | 纯配置契约 `McpTransportSpec::{Stdio, StreamableHttp}` 与 `McpServerConfig`，供后续 OAR 安装器作为单一真源消费 |
| `redact.rs` | 通用密钥脱敏 `scrub_secrets`、`scrub_tool_result`、`scrub_resource_content` |

### 消费方重构

- **服务端**：[crates/server/src/agent/mcp/mod.rs](crates/server/src/agent/mcp/mod.rs) 实现 `McpHandler`，通过 `SkillCatalog::from_embedded_entries` 直接以 `skill://artifact/<type>` 暴露全部 12 类作品指南；[crates/server/src/gateway/http/server.rs](crates/server/src/gateway/http/server.rs) 在 `POST /mcp` 入口执行 SEP-2243 头校验并回写 `MCP-Protocol-Version` 与 `Cache-Control` 响应头，同时不引入跨模块边界依赖。
- **命令行**：[crates/cli/src/domains/mcp.rs](crates/cli/src/domains/mcp.rs) 实现 `McpHandler` 并复用 `serve_stdio`、`ToolDef`、`ToolCallResult` 与 `scrub_tool_result`，保留全部 17 个工单与 VDP 工具并同步获得 `server/discover` 与 `skills/*` 能力。

## Alternatives considered

### Why not put MCP protocol types inside `crates/protocol`?

`crates/protocol` 是 VibeValley 前后端（Rust ↔ TypeScript）自有 API 契约与生成物单一真源，绑定了 `shapes.gen.ts` 与 `endpoints.gen.ts` 生成链。把第三方开放标准 MCP 的传输层、stdio 循环和 `skill://` 目录解析塞进 `crates/protocol`，会污染前后端契约边界并拖慢无关 crate 的编译。

### Why not include Coding Agent MCP installation/detection in `crates/mcp`?

不同编码 agent（Antigravity、Claude Code、Codex、Cursor）的配置文件路径、CLI 参数和探测策略属于运行时适配层，已经在 `crates/runtime/src/oar/` 统一收敛。把它们放入 `crates/mcp` 会打破纯协议边界并导致反向依赖；让 `crates/mcp` 只提供纯 `McpServerConfig` 契约，OAR 在上层完成探测与安装，职责最清晰。

### Why not adopt an external third-party MCP SDK crate?

外部 Rust MCP SDK 版本碎片化严重，对最新 SEP-2575（无状态 `server/discover`）、SEP-2243（路由头 `-32020`）和 SEP-2640（`skill://`）覆盖滞后，且往往自带额外宏与执行器绑定。自研 ~600 行零冗余的纯协议 crate 可以紧跟官方 SEP、完全受控于工作区 `clippy` 与异步规范。

## Acceptance criteria

- `crates/mcp` 独立通过 `cargo clippy --all-targets -- -D warnings` 与集成测试套件，覆盖 SEP-2575 免 `initialize` 调用与 `server/discover`、SEP-2243 头匹配与 `-32020` 拒绝、旧版 `initialize` 兼容、SEP-2640 `skills/list`/`skills/get`/`skill://` 读写、stdio 循环、配置序列化与密钥脱敏。
- `crates/server` 的 `POST /mcp` 与既有 `crates/server/tests/mcp.rs` 全部通过，并暴露全部 12 类 `skill://artifact/<type>` 作品指南。
- `crates/cli` 的 `vibevalley mcp` 与 `crates/cli/tests/mcp_stdio.rs` 全部通过，保留全部 17 个工具且无密钥泄漏。
- `cargo xtask audit`（模块边界与并发棘轮）与 `vp run docs:verify` 全部通过。

## Risks

- **旧版客户端头兼容**：部分现有编码 agent 客户端不会发送 `MCP-Protocol-Version`、`Mcp-Method` 或 `Mcp-Name` 请求头。缓解：缺失头一律宽松放行，仅在请求显式携带且与 JSON-RPC 载荷冲突时返回 `-32020`。
- **协议草案微调**：SEP-2575 / SEP-2243 / SEP-2640 仍处于演进期，字段或扩展键可能调整。缓解：所有协议常量与编解码集中收口在 `crates/mcp/src/{protocol,stateless,skills}.rs`，上游服务端与 CLI 不直接硬编码协议字面量。
