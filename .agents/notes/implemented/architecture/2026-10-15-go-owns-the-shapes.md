# Agent Note: 形状的源头是 Go：TypeScript 退出

Status: implemented

## Problem

[网页退役](../simplification/2026-10-14-retire-the-web-page.md)以后，规则只剩 Go 一份，形状却还从 TypeScript 来：`packages/protocol` 用 Effect Schema 写形状，`export-schemas.ts` 导出 OpenAPI 和 JSON Schema，再由两个 Node 写的生成器分别生成 Go 的 `gen.go` 和 Dart 的 `vibevalley.dart`。为了这条链，仓库里留着一个 pnpm workspace、Effect、Vite+ 的格式和 lint、一份锁文件，和一个专门检查 Go 服务端是否符合 TypeScript 接口的契约脚本。服务端是 Go，客户端是 Flutter，中间却隔着第三种语言：加一个字段要先写 Effect Schema、导出、再跑两个生成器，三种语言的人都得懂。

## Decision

形状和接口写在 Go 里，一个 Go 写的生成器从它们写出其余的一切。

- **源头**：`server/internal/protocol/shapes.go`（核心状态、事实、工地事件、帧、请求和回答）和 `server/internal/protocol/api.go`（`Handlers` 接口，每个接口一个方法）。都是手写的普通 Go 类型，几处用注释指令说清 Go 类型系统说不出的东西：`//vibevalley:union <字段>`（带标签的联合）、`//vibevalley:member <联合> <值>…`（它的成员和标签值，一个成员可以属于几个联合）、`//vibevalley:error <状态码>`（接口的错误）、`//vibevalley:route <组.名> <方法> <路径>`（接口）、`//vibevalley:dart <名字>`（和 Flutter 撞名时的 Dart 名）；字段上 `omitzero` 是可选，指针是可空，切片、表、联合写不成指针的用 `vibevalley:"null"`。
- **生成器**：`server/tool/shapegen`（`go run ./tool/shapegen`，`-check` 只查），用 `go/ast` 读这两个文件，写出 `internal/protocol/gen.go`（联合的编解码和成员表、必填的空切片和空表写成 `[]`/`{}`、枚举的值、错误类型、`Mount`；Go 不查类型 `switch` 漏没漏成员，要每种都处理的地方用成员表写测试）和 `app/lib/gen/vibevalley.dart`（类型、sealed class、`VibeValleyApi` 客户端，经 `dart format`）。`bun run flutter:check` 先跑 `-check`。
- **怎么搬过来的**：第一份 `shapes.go`、`api.go` 由原来的 `gen.go` 机械转出（去掉生成的方法，补上指令；标签值、路由和操作名从它和 OpenAPI 里读）。新生成的 `gen.go` 和原来的逐个函数比，360 个函数和路由里只差连接器接口的路径参数从 `string` 变成 `ConnectorID`；新的 `vibevalley.dart` 和原来的逐个声明比，238 个声明一样，只少了 Flutter 从来没用过的 6 个错误类和它们的 `…Tag` 枚举，`ChannelRequest2` 改叫 `ConnectorsChannelRequest`，`SiteEvent` 的 `switch` 里一条换了位置。原来 TypeScript 写成 `NullOr(Array)` 的五个字段（`RuntimeInfo` 的）在 Go 里看不出可空，比对 Dart 时找出来，补了 `vibevalley:"null"`。
- **删掉的**：`server/contract/`（`@heybro/protocol`、`@heybro/tools`：Effect 的形状、导出脚本、契约检查）、`server/tool/go_types.ts`、`app/tool/dart_types.ts`、两个 `generate.sh`、中间的 schema 文件（`site.schema.json`、`vibevalley.openapi.json`、`site-frame.schema.json`）、根目录的 pnpm workspace、锁文件、`vite.config.ts` 和 Vite+ 的提交钩子。种子数据 `server/internal/protocol/seeds.json` 从导出物变成直接改的数据文件。
- **还剩的 Node**：`server/tool` 的两个脚本（倒出旧的 PGlite 数据库、写 pi 的价目表，自己一个 `package.json`），用 Node 24 直接跑；`scripts/` 的文档检查当时也是，后来改用 Bun 跑（[Note 的目录由脚本生成](../process/2026-10-15-notes-catalog.md)）。根目录的 `package.json` 只剩几个命令，没有依赖。

这一篇取代了 [服务端和客户端两个目录](2026-10-15-server-and-app.md) 里的 `server/contract/`、[Go 服务端](2026-10-13-go-server-on-smith.md) 里「TypeScript 的 protocol 仍是形状的唯一来源」、[Flutter 客户端](2026-10-13-flutter-client-over-ts-server.md) 里「形状从 protocol 导出」，和 [Vite+ 工具链](../process/2026-10-13-vite-plus-toolchain.md) 整篇。

## Alternatives considered

**让 Go 用反射导出 JSON Schema，保留两个 Node 生成器。** 改动最小，但 `gen.go` 本身既是生成物又是类型的来源，会绕成圈；Node 也还得留着。

**手写 JSON Schema 或 OpenAPI 当源头。** 中立，但几千行 JSON 没人愿意手改，也没有编译器帮着查。

**用 `go/types` 或反射读形状，而不是 `go/ast`。** 反射丢了注释（指令和接口的说明都在注释里），`go/types` 要把整个包连同 `gen.go` 一起类型检查，生成物坏了生成器自己也跑不起来。形状文件只用到几种写法，`go/ast` 够了。

**把 `Mount` 和联合的编解码也手写。** 一百多个联合成员和七十多个接口，手写的样板会和形状悄悄对不上；生成它们，加一个成员或接口只动一处。

**Dart 的数字用 `int`。** Go 里次数、时间、编号是 `int64`，按理 Dart 该是 `int`；但原来的生成器一律是 `double`，Flutter 里到处按 `double` 算，改它是另一件事。

## Consequences

- 加一个字段、事实或接口：改 `shapes.go` 或 `api.go`，跑 `go run ./tool/shapegen`，Go 编不过的地方就是还没接上的地方，Flutter 编不过的同样。只有一种语言写形状。
- 契约不再要单独检查：服务端和客户端的类型出自同一份 Go，不会对不上；原来的 `go-contract.ts` 删了。
- 生成器是自己写的，也只认这几种写法：形状里用了别的 Go 写法（匿名结构体、别的基本类型），它会报错而不是猜。
- Dart 名字由 Go 名字推出来（`MCPServer` → `McpServer`），撞名的用 `//vibevalley:dart` 指定。
- TypeScript 的格式和 lint 没有了：剩下的几个脚本直接跑（`server/tool` 的靠 Node 的类型擦除，`scripts/` 的用 Bun），没人查它们的格式。

## Verification

- 新旧 `gen.go` 逐个函数比、新旧 `vibevalley.dart` 逐个声明比，差别只有上面列的几处。
- `go vet ./... && go test ./...`（黄金数据、示例帧都过）、`bun run flutter:check`（`shapegen -check`、`flutter analyze`、277 个测试）、`bun run docs:verify`；`bun run package:mac` 打出的应用里，服务端起得来、接口有应答。
