# 官方指南的每一节在这里

`node_modules/effect/AGENTS.md`（effect 4.0.5）的每一节，在这个仓库用不用、对应哪里。指南本身不复制：读它，再看这里它落在哪。入口见 [SKILL.md](.agents/skills/vv-effect/SKILL.md)。

| 指南的一节 | 在这里 |
|---|---|
| Writing `Effect` code（`Effect.gen`、`Effect.fn`、`Effect.fnUntraced`，不写只包一层 `Effect.gen` 的函数） | 照做。服务的方法用 `Effect.fn("X.m")`，热路径和薄的取值用 `Effect.fnUntraced`；lint `vibevalley/service-method-names` 查 |
| Defining schemas and domain models（一切校验用 `Schema`，不手写判断） | 照做。线上的形状在 `packages/protocol/src/schema.ts`，库里的 JSON 照 Schema 读（[地基](docs/subsystems/foundation.md)） |
| Writing Effect services（`Context.Service` 的类、`static layer`、`X.of`、`X["Service"]`） | 照做，24 个服务都是这个写法（`AGENTS.md`「服务端的服务」）；layer 按 `apps/server/src/services.ts` 的次序叠 |
| Error handling（`Schema.TaggedError`，`catchTag`、`catchTags`、`catchReason`） | 照做，错误都是 `Schema.TaggedError`（`preferSchemaTaggedError`、`extendsNativeError` 查）；按标签接，不用 `instanceof` |
| Managing resources and Scopes（`acquireRelease`、`Layer.effectDiscard`、`LayerMap`） | 照做；后台的 fiber 归服务的作用域，外面回调用 `FiberSet.makeRuntime*`（[地基](docs/subsystems/foundation.md)） |
| Running Effect programs（`NodeRuntime.runMain`、`Layer.launch`） | 服务端的入口 `apps/server/src/main.ts`；命令行 `apps/server/src/cli.ts` |
| Broadcasting messages with PubSub | 用在核心状态和事件往上走的流（下层经 `Stream` 告诉上层） |
| Working with Streams | 用：SSE 的帧、帮工的事件、频道的消息；有界的 relay 见 [architecture.md](docs/architecture.md) |
| Integrating Effect into existing applications（`ManagedRuntime`） | 少用：Promise 一侧只剩外面库的一次调用；桌面壳和页面不是 Effect |
| Batching external requests（`RequestResolver`） | 不用：外面的请求没有批量的需要 |
| Working with Schedules（`Effect.retry`、`Effect.repeat`） | 照做：语音的重试、隧道的探问是 `Schedule`；连接器收消息的循环按分支（暂停到某一刻、换代、失败的节奏）各等各的，留着手写 |
| Working with DateTime | 时间经 `Clock`；格式化在需要的地方用 |
| Observability（日志、OTLP 追踪） | 用：日志经 Effect（`infra/log.ts`），OTLP 在 `main.ts` 接上 |
| Testing Effect programs（`@effect/vitest`、共享 layer） | 照做：`it.effect`、`TestClock`；服务端用 `testing/world.ts` 搭农场，`packages/agent` 用 `testing.ts` 的 `withAgent`（大脑在测试的纤程上，钟是 `TestClock`） |
| Runtime type guards（`Predicate`） | 照做：对象用 `Predicate.isObject`、`Predicate.hasProperty`，不手写 |
| Working with SQL databases（`effect/sql`） | 用，经 `Db` 服务和 effect-sqlc 生成的查询（`apps/server/db/`） |
| Effect HttpClient | 外面的 HTTP 经 `HttpClient`（[地基](docs/subsystems/foundation.md)）；Promise 一侧还有几处直接 `fetch` |
| Building HttpApi servers | 不用：接口表是 `packages/protocol/src/api.ts` 自己的，处理在 `apps/server/src/handlers.ts` |
| Typed GraphQL clients | 不用 |
| Working with child processes（`ChildProcessSpawner`） | 用：git 和外部命令（`apps/server/src/project/git.ts`） |
| Building CLI applications（`effect/cli`） | 用：`apps/server/src/cli.ts` |
| Working with AI modules | 不用：模型在 `packages/ai`，大脑在 `packages/agent`，都是自己的 |
| Building distributed applications with cluster | 不用：服务端只有一个进程 |
