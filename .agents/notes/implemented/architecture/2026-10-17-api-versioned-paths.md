# Agent Note: 接口带版本，都在 /api/v1 下

Status: implemented

## Problem

客户端不总是一起升级。macOS 应用把服务端带在里面，一起换；手机和别的设备经院门连到主人的服务端，什么时候升级由那台设备定。所有接口原来都叫 `/api/...`：改一个名字（刚做完的 Worker 改叫 Session、路由按概念改），就同时打断所有旧客户端，服务端也没有办法从请求上看出对面说的是哪一版。

没有版本时只有两条路：形状永远只加不改，或者所有设备必须同一天升级。前者锁死了改名和组织方式，后者做不到。

## Decision

- **每个 HTTP 接口都在 `/api/v1` 下**：`server/internal/protocol/api.go` 里每条 `//vibevalley:route`、两条 SSE（`/api/v1/state`、`/api/v1/events`），以及 `/api/v1/health`。`/mcp` 不带版本：MCP 有自己的版本，工具是给编码 agent 的，另算。
- **版本在路径里，不在请求头**：curl、命令行、院门的放行表、日志都直接看得见。`protocol.Endpoints` 里的路径就是最终路径；生成的 Flutter 客户端、`cmd/vibevalley` 和[能力表](../../../../docs/reference/capabilities.md) 都从它来，没有第二处拼前缀。
- **不兼容的改动另起 `/api/v2`**，v1 留到主人的设备都升上来再删；加字段、加接口这种向后兼容的改动留在 v1。
- **不设 `/api/...` 的别名**（[不留兼容](2026-10-16-one-schema-no-old-data.md)）：旧客户端拿到 404，说明它要升级。这台电脑上的应用、命令行和测试是同一个包，一起换。
- **院门只放 `/api/v1/` 下的路径**；`/mcp` 仍然不放（[院门](../feature/2026-10-14-yard-gate.md)）。

## Alternatives considered

**不分版本，只做加法。** 形状能加不能删，路由和组织方式也被锁死；刚做完的 Worker 改叫 Session 这种改名永远做不了。

**版本放请求头**（`Accept: application/vnd.vibevalley.v1+json`）。URL 干净，但 curl、日志和院门的放行表都要多一层解析，Flutter 客户端也要多传一个头；路径里的版本同样清楚，还不用多写代码。

**每个操作自己带版本**（`issue.v2`）。同一个概念散在几个版本里，读的人和客户端都难拼出「我现在说的是哪一版」；按整份 API 分，一次只说一个数。

**留着 `/api` 当 v1 的别名。** 旧客户端不用改，但两个名字要一直维护，也分不清谁是新客户端。

**在反向代理或网关上做版本映射。** 本机服务端前面没有网关，多一层只为了改名，还多一处要配的东西。

## Consequences

- 所有客户端、命令行、测试、文档和验证 skill 同一天改；这台电脑上的都一起发。经院门连的手机和别的设备要升一次，没升的连不上，顶上说连不上服务端。
- 以后不兼容的改动有地方放：`/api/v2` 和 v1 并存一段，服务端挂两个 mux。形状要是也变了，protocol 里要留两套形状，所以能留在 v1 的改动尽量留。
- 能力表、生成的客户端和命令行自动带上前缀；加接口时不用再想一次路径怎么写。
- 旧版本的设备升级前，v1 不能删；这是唯一一处「有兼容负担」的地方，负担是明确的，不是隐形的。

## Verification

- `go vet ./... && go test ./...`、`go run ./tool/shapegen -check`、`bun run flutter:check`、`bun run docs:verify`。
- 真的服务端：`GET /api/v1/health` 200，`GET /api/health` 404；`GET /api/v1/state` 推帧；配对的设备经院门读 `/api/v1/health` 200，读 `/api/v1/gate` 被拒。
