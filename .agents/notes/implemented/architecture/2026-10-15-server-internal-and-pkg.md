# Agent Note: 服务端一个模块：internal 和 pkg，smith 并进来

Status: implemented

## Problem

服务端原来是两个 Go 模块：`server/` 是 `vibevalley`，里面的 `smith/` 是另一个模块 `smith`，靠 `replace => ./smith` 接进来。包都平铺在模块根上（`farm`、`protocol`、`ai`、`agentcore`、`agent`），看不出哪些是只给这个项目用的、哪些是能单独拿去用的库。两个模块还要两套 `go vet`、`go test`，smith 的测试得进它的目录另跑，改 smith 的接口时两边的检查也是分开的。

## Decision

`server/` 只有一个模块 `vibevalley`，按 Go 常见的布局分成四块：

- `cmd/`：命令，`server`（服务端）、`vibevalley`（VibeValley 自己的 agent 的命令行）和 `migrate`（表结构）。
- `internal/`：只给本模块用的：农场的服务（一个概念一个包，`farm` 把它们组装起来，见 [一个概念一个包](.agents/notes/implemented/architecture/2026-10-16-a-package-per-concept.md)）和 `protocol`（形状、接口和规则；shapegen 读它的 `shapes.go`、`api.go`，写它的 `gen.go`）。
- `pkg/`：能单独拿去用的库：`smith`（oar 的 Go 移植，驱动各家编码 agent），`agent`（含 `oarruntime`）、`agentcore`、`ai`（VibeValley 自己的 agent）；后来又有了 `db`（sqlc 生成的查询，[查询由 sqlc 生成](.agents/notes/implemented/architecture/2026-10-15-sqlc-queries.md)）和 `agora`、`weixin`、`feishu`、`qq`（声网和三家聊天软件的接口，[一个概念一个包](.agents/notes/implemented/architecture/2026-10-16-a-package-per-concept.md)）。
- `tool/`：开发时的工具（shapegen、两个 Node 脚本）。

smith 整个搬进 `pkg/smith`，删掉它的 `go.mod` 和 `replace`，import 从 `smith/…` 改成 `vibevalley/pkg/smith/…`。它没有第三方依赖，合并不给 `go.mod` 添东西。smith 自己的 `internal/` 和命令行 `cmd/oar`、`cmd/oar-bridge` 跟着它留在 `pkg/smith` 下面：Go 的 `internal` 只许它的上一层目录引用，这两个命令用到 smith 的 `internal/executable`，搬到 `server/cmd` 就编不过。`go vet ./...`、`go test ./...` 一次查完全部（32 个包，smith 那部分约一分半）。

## Alternatives considered

**smith 留着单独的模块。** 它来自 oar，单独成模块方便以后和上游对照；但上游是 TypeScript，Go 这份只有这个项目在用、在改，两个模块只换来两套检查和一个 `replace`。

**protocol 放进 pkg。** 形状是服务端和客户端的契约，看起来像该公开；但它里面也是农场的规则（`Reduce`、计划、定时……），客户端拿的是生成出来的 Dart，没有别的 Go 代码要用它。放在 `internal` 说清了它只属于这个服务端。

**smith 的命令搬到 server/cmd。** 命令都放 `cmd/` 更整齐，但它们引用 smith 的 `internal` 包，要么把那些包公开、要么挪到 `server/internal`，smith 就被拆在两处。留在 `pkg/smith/cmd` 下，smith 是完整的一块。

## Consequences

- 改 smith 的接口和改用它的农场代码在同一次 `go vet`、`go test` 里检查，`go test ./...` 慢了一分半。
- `internal` 里的东西别的模块引用不了；以后真要给别人用，先挪到 `pkg`。
- 文档、Note 和注释里写着 `server/farm`、`server/protocol`、`server/smith` 的地方都改成了新路径。
