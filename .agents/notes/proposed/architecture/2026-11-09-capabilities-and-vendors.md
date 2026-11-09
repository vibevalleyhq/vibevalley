# Agent Note: 能力不认供应商，供应商是适配器

Status: proposed

## Problem

`Provider`（`apps/server/src/provider/provider.ts`）每个用途一个方法（`image()`、`speech()`、`live()`…），交出的是「哪个 MOSS 连接、钥匙、模型」，模型的类型写死成 MOSS 的型号表；用的地方（Media、语音）再直接调 `@vibevalley/provider/moss/*` 里 MOSS 专用的函数（`prepareMossImage`、`generateMossImage`）。DeepSeek 与声网不归它，钥匙在 `Setting` 各自的字段上。结果：

- 加一家供应商要改 `Provider` 的每个方法和每个调用方。
- 「支持哪些模型」「准备好没有」「怎么调」各写各的：`Provider.image()` 里一份绑定规则，`setting/readiness.ts` 又一份。
- 钥匙是普通字符串，靠输出时替换防漏。

## Proposal

**能力是 `Provider` 上不认供应商的接口。** 一个模块一个服务（AGENTS.md），所以能力不另起服务，而是 `Provider` 上一个能力一个方法，接口里不出现供应商。先做生图：`Provider.image(request)` 在交任务时核对绑定、按所选模型校验参数，交出账号快照（连接、版本、模型，任务落库记下它）和一个之后才跑的 `run: Effect<GeneratedImage, ImageFailure>`。结果与错误是能力自己的形状（图片地址与用量；`Rejected` 或 `Unknown`），不是厂商的。调用方（Media）只依赖这个接口；和供应商打交道归 `Provider`，`run` 用 `Provider` 自己的 `HttpClient`（导出的类型里不出现 `effect/http`）；钥匙收在 `run` 里，不再交给调用方。

**供应商是适配器，目录是数据。** `apps/server/src/provider/vendors.ts` 一家一条：名字、取钥匙的地方、支持的能力和每个能力的模型（取自 `@vibevalley/provider` 的型号表）、每个能力的实现。`Provider` 按绑定的连接的 `adapter` 找到实现。设置页（「账号与钥匙」）、准备状态、模型校验都读这份目录。

**一条绑定规则。** 「这个用途绑定了哪个启用的、有钥匙的连接，缺什么」写成一个纯函数，放在 `setting/provider.ts`（`Setting` 排在 `Provider` 前面，两边都能用）：`readiness.ts` 与 `Provider` 的能力方法都调它，结论一致。

**钥匙是 `Redacted`。** 账号钥匙在 Schema 里用 `Schema.Redacted`，启动配置里的钥匙用 `Config.redacted`：打日志、编码时出不来。

三步，一步一个提交，行为不变：

1. 绑定规则合成一个（`setting/provider.ts` 的 `bindingOf`）；供应商目录（`provider/vendors.ts`），MOSS 生图走通；`Provider.image(request)` 交出不认供应商的绑定；Media 不再 import MOSS。
2. 其余 MOSS 能力（理解、语音、多人语音、音色设计、转写、听写、Live、实时视觉）照做，DeepSeek（管家的对话模型）、声网（通话线路）进目录；`Provider` 只剩连接的增删改与目录查询。
3. 钥匙改 `Redacted` 与 `Config.redacted`。

## 进度

| 步 | 状态 | 提交 | 做了什么 |
|---|---|---|---|
| 1 生图 | 完成 | `8d3b2d396` | `bindingOf`；`vendors.ts`（只放数据：名字、取钥匙处、模型表）；MOSS 的调用在 `provider.ts` 里、不导出；`Provider.image(request)` 交出的 `run` 不再要求 `HttpClient`（Provider 用自己的），Media 不再依赖 `HttpClient`、也不 import MOSS |
| 2 其余能力 | 未做 | — | |
| 3 `Redacted` | 未做 | — | |

## Alternatives considered

- **用 `Config` 读账号钥匙。** `Config` 是启动时读一次的（环境变量、`vibevalley.yaml`）；账号与绑定是主人运行中改的（`settings.json`），由能力服务每次按当前设置解析。启动配置里的钥匙才用 `Config.redacted`。
- **一个能力一个 `Context.Service`。** 照 Effect 的写法最直接，但仓库一个模块只导出一个服务；能力挂在 `Provider` 上，供应商的差别都收在 `vendors.ts`，调用方一样不认供应商。
- **每家供应商一个 `Layer`，启动时选。** 绑定能在运行中换，一个启动时定死的 `Layer` 换不了；按连接与版本解析，必要时缓存。

## Acceptance criteria

- Media 不 import `@vibevalley/provider/moss/*`；生图经 `Provider.image(request)`，交出的绑定里没有钥匙。
- 绑定规则只有一份（`bindingOf`），准备状态与 `Provider` 的能力方法都调它。
- 现有的媒体测试（排队任务保留账号快照、换钥匙、未知结果、下载重试）不改断言地通过。
- `server:check`、`web:check`、`effect:check`、`paths:check` 通过。

## Risks

- **排队任务的账号快照**：快照在 `Provider.image` 时取（钥匙也在那时取），`run` 用它；`regression: queued generations keep their account snapshot after key rotation` 守着。
- **测试替身**：媒体测试给的假 `HttpClient` 现在要交给 `Provider`：各测试在新建的 Media 下面也新建一个 `Provider`（`Layer.fresh(Provider.layer)`）。
