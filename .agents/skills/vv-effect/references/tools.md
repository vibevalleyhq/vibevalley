# 器：查什么、拿什么查

写 Effect 时用得到的工具：去哪儿查 API，哪个检查拦什么、怎么读它的报错，测试和观测用什么，要加一条新检查写在哪。为什么这样写见 [principles.md](.agents/skills/vv-effect/references/principles.md)，具体写法见 [cases.md](.agents/skills/vv-effect/references/cases.md)，入口见 [SKILL.md](.agents/skills/vv-effect/SKILL.md)。

## 查 API

| 要知道的 | 去哪儿 |
|---|---|
| 这个版本的写法、该用哪个模块 | `node_modules/effect/AGENTS.md`（包自带，和装的版本一致，先读它），再按它的链接读 `node_modules/effect/ai-docs/src/**` |
| 一个函数在不在、签名是什么 | 源码：`grep -n "^export const fn\b" node_modules/effect/src/Effect.ts`；子路径（`effect/cli`、`effect/process`、`effect/http`、`effect/testing`）在 `node_modules/effect/src/<目录>/` |
| 装的是哪个版本 | `node -p "require('./node_modules/effect/package.json').version"`（现在是 4.1.2；版本以它为准，资料里写的版本只作参考） |
| 网上的文章、skill | 大多是 v3 或 v4 测试版的名字（`Effect.Service`、`catchAll`、`Either`、`ServiceMap`、`Config.redacted`），照着写之前在源码里搜一遍；对照表见 [practices.md 的 v3 → v4](.agents/skills/vv-effect/references/practices.md#v3--v4) |

## 检查：谁拦什么

| 工具 | 跑法 | 拦什么 |
|---|---|---|
| Effect 的语言服务 | `vp run effect:check`（`@effect/tsgo`，规则和级别在 `tsconfig.base.json` 的 `plugins`，警告也算失败）；编辑器里经 `packages/tsrs/tsdk` 显示同一张表 | 漂着没运行的 Effect、gen 里的 `try/catch`、少了 `return yield*`、v3 的旧 API、Effect 里 `run*`、方法签名漏出依赖、`process.env`、`setTimeout`、`fetch`、`Math.random`、Effect 里同步解码、原生 `Error` 当失败……一共 48 条，开着哪些看那张表 |
| oxlint（带类型） | `vp check` | TypeScript 的不安全写法（`any`、不安全的断言、漂着的 Promise）和这个仓库的 `vibevalley/*` 规则：`promise-boundary`、`try-promise-catch`、`service-method-names`、`no-instanceof-tagged`、`no-object-guard`、`no-wall-clock`、`clock-in-effect`、`scoped-fibers`、`yield-in-loop`、`db-door`、`child-process-door`、`sync-fs`、`no-test-sleep`、`atom-door` 等，每条在 `scripts/oxlint-plugin.ts` 里，失败时说错在哪、`Fix:` 怎么改、`See` 哪个文件 |
| 逃生口的棘轮 | `vp run health:verify`（报告是 `vp run health`，降了用 `vp run health:write` 固定下来） | `as`、`!`、关 lint 的注释、`Effect.orDie`、不带 `{ log }` 的 `Effect.ignore`、空的 `catch`、`Effect.result` 的分支：按区只许减不许增 |
| 测试的分层和预算 | `vp run server:check` 里的 `pyramid.test.ts` 和预算报告 | 测试放对层（规则、模块、流程），慢的测试报出来 |

真要在一行上违反一条：Effect 的诊断写 `// @effect-diagnostics-next-line <规则>:off`，lint 写 `// oxlint-disable-next-line <规则> -- <为什么>`，上一行说清为什么；这些注释都在棘轮上。

读报错：先看诊断的名字（`missingReturnYieldStar`、`vibevalley/promise-boundary`），在 [cases.md](.agents/skills/vv-effect/references/cases.md) 里搜同一个名字，那一条的「建议」就是改法。

## 测试

| 要测的 | 用 |
|---|---|
| 一段 Effect | `@effect/vitest` 的 `it.effect`（服务端），断言照常 `expect` |
| 时间 | `TestClock`（`import { TestClock } from "effect/testing"`）：`TestClock.adjust("1 minute")`、`setTime` |
| 等一个条件成立 | `@vibevalley/testkit/until`，不用 `sleep` |
| 一个整农场 | `apps/server/src/testing/world.ts`；帮工是 oar 的 `scriptedRuntime`，模型是照脚本回答的 `Llm`（`@vibevalley/ai/testing`） |
| 规则的黄金数据 | `@vibevalley/testkit/golden`，有意改了规则 `vp run golden:update <模块>` |
| 贵的资源跨测试共享 | `it.layer(…)`，只给真贵的（数据库、整个服务），说清共享了什么 |

## 观测

- `Effect.fn("模块.函数")` 给每次调用一个 span，错误的堆栈也指到定义的地方。这个仓库现在**没有接 trace 的导出**（没有 OpenTelemetry），span 的名字先留着：堆栈今天就用得上，接上导出以后 trace 也就有了。
- 日志经 Effect 的 `Effect.log*`，值放进 `Effect.annotateLogs`；「出错了记一笔、接着做」用 `apps/server/src/infra/log.ts` 的 `bestEffort(what)`。
- 看一个服务端跑起来的样子：照 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 起一个隔离的服务端，看接口和 `/api/v1/state`。

## 加一条检查

- **先问能不能写成代码**（更好的结构、更强的类型），再写检查，最后才写进文字（`AGENTS.md` 的「怎么让 agent 做对」）。
- **lint 规则**写在 `scripts/oxlint-plugin.ts`，用 `says(错在哪, Fix, See)` 写报错，测试写在 `scripts/oxlint-plugin.test.ts`（`vp run scripts:test`），在根目录 `vite.config.ts` 的 `lint` 里打开；能机械改对的写自动修复。这个仓库不另加 ast-grep：oxlint 已经在 `vp check` 里跑、带类型（[vv-governance](.agents/skills/vv-governance/SKILL.md)）。
- **存量太多一次改不完的**，先进逃生口的棘轮（`packages/health`），只许减；新写的照规则来。
- **Effect 自己的诊断**能开就开：在 `tsconfig.base.json` 的 `plugins` 里把它调成 `error`，`vp run effect:check` 会报。

## 外面的工具

- [agent doctor](https://effect.doctor/)（`npx @jgalbsss/agent-doctor`）：给 Effect 代码打分的体检，101 条规则（正确性、v4 迁移、惯用写法、架构、性能、重复的函数）。不在这个仓库的检查里；要用它做一次审计时先问主人（它会下载并运行第三方的包），报出来的照 [cases.md](.agents/skills/vv-effect/references/cases.md) 判断，值得的写成上面的检查。
- [EffectPatterns](https://github.com/PaulJPhilp/EffectPatterns)：300 多个按主题分的模式（`content/published/patterns/<主题>/`），找某一类问题的标准写法时查；它按 v3 写的多，名字照上面「查 API」核对。
