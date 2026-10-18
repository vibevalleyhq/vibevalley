# Agent Note: 网页退役：删掉网页，规则只留 Go 一份

Status: implemented

## Problem

[一个服务端、一个客户端](2026-10-14-one-server-one-client.md)把网页冻结在了原处。留着它的理由有三条：逐页对照 Flutter 的参照、不起服务端就能调画面的模拟服务器和调试台、对照测试的基准（TypeScript 的 `reduce` 和规则）。冻结以后，这三条都不值它的代价了：

- **规则有两份**：每改一条规则（比如种植计划的验收步骤），TypeScript 和 Go 各写一遍，再重新生成对照数据，网页早就不加功能了，这份 TypeScript 只为了对照而存在。
- **对照的参照已经落后**：Flutter 上的新功能网页上没有，逐页对照只剩老页面能比。
- **模拟服务器和调试台只服务网页**：Flutter 调试连真服务端，它的调试台也是对着真服务端的。
- **代码和依赖**：网页、`packages/core`、`packages/engine` 一万多行 TypeScript，React、Vite 的构建和一棵依赖树（锁文件少了两千多行），`pnpm build`、`pnpm test` 都只为它们而在。

## Decision

- **删掉的**：`web/`、`packages/core`、`packages/engine`；Go 服务端不再发页面（当时的 `Farm.Handler` 没有了页面参数，没有 `VIBEVALLEY_WEB_DIR`；HTTP 处理现在是 `internal/handler` 的 `handler.New`）；根目录的 `build`、`test` 脚本和 `vite.config.ts` 里的测试、React 和 core 的 lint 规则；只给网页用的脚本 `app/tool/screens/web_shoot.mjs`、`app/tool/sfx_fixture.ts`（都已不在）。
- **protocol 只有形状**：`packages/protocol` 删掉了全部规则（`farm.ts`、`chat.ts`、`task.ts`、`progress.ts`、`recall.ts`、`schedules.ts`、`patrol.ts`、`settings.ts`、`desktop.ts`，以及其余文件里的函数和只给规则用的常量），只留 schema、编解码、导出要的种子数据。导出的 OpenAPI、JSON Schema 和 `seeds.json` 和删之前一个字节不差（`schemas:check`），Go 和 Dart 的生成类型没变。（`packages/protocol` 后来整个删了，形状改写在 Go 里，见 [形状的源头是 Go](../architecture/2026-10-15-go-owns-the-shapes.md)。）
- **规则只在 Go**：`server/internal/protocol` 是唯一的一份。原来由 TypeScript 算出期望的对照数据（`internal/protocol/testdata/*.jsonl.gz`）改成 Go 自己的黄金数据：`internal/protocol/golden_test.go` 逐条比，有意改了规则就 `go test ./internal/protocol -update` 用 Go 的结果重写，再看 diff。改写时验证过：用 Go 重写一遍，和 TypeScript 写的相比，只有原来的测试本来就容忍的差别（计划 JSON 读不了时报错的措辞、1e-12 以内的浮点、被切开的 emoji 半个代理字符写成 `�`）。
- **示例帧由 Go 写**：Flutter 解码测试用的 `app/test/fixtures/state-frame.sample.json` 从 TypeScript 导出改成 Go 的编码器写（同一个测试文件），和原来的一字不差。
- **冻结的对照**：Flutter 音效合成的对照 `app/test/fixtures/sfx.json` 是网页的合成器算的，留着、不再生成，改了声音就手改。
- **还是 TypeScript 的**：`packages/protocol`（形状）和 `tools/`（导出形状、`go-contract.ts` 用 `HeybroApi` 的客户端检查正在跑的 Go 服务端、pi 的价目表）。这一条后来被 [形状的源头是 Go](../architecture/2026-10-15-go-owns-the-shapes.md) 取代：两样都删了，pi 的价目表改由 `server/tool/pi-prices.ts` 写。

这一篇取代了 [一个服务端、一个客户端](2026-10-14-one-server-one-client.md) 里「网页冻结」的部分，和 [核心状态](../architecture/2026-10-11-farm-core-state.md)、[规则是纯函数](../architecture/2026-10-11-session-rules-as-pure-functions.md) 里「同一个函数在服务端和页面上跑」的部分：核心状态仍然只有一份、规则仍然是纯函数，只是只在 Go 里。

## Alternatives considered

**照旧冻结。** 冻结省掉了网页的新功能，省不掉规则的第二份：只要 TypeScript 的 `reduce` 还是对照的基准，每条规则都要写两遍。网页本身已经没有人用。

**只删网页，留着 TypeScript 的规则当对照基准。** 那样 TypeScript 规则没有任何使用者，只是为了生成测试期望而维护的第二份实现；用它守 Go 的一份，不如直接让 Go 的结果成为黄金数据、靠 diff 审查改动。原来的数千条随机输入照样留着。

**由 Go 定义形状，再生成 TypeScript 和 Dart。** 形状的来源换到 Go，protocol 包也能删。但 Effect Schema 导出 OpenAPI 和 JSON Schema 这条链已经稳定，Go 和 Dart 的生成器都读它；换来源要重写生成器，而这次要解决的是规则的重复，不是形状。后来还是换了（[形状的源头是 Go](../architecture/2026-10-15-go-owns-the-shapes.md)）。

**用 moejs 在 Go 里跑 TypeScript 的规则，删掉 Go 的移植。** 考虑过（[先采样，再验收](../../proposed/architecture/2026-10-14-sample-then-verify.md)）：protocol 依赖 Effect、模块初始化重，`Site.Apply` 每个事实都要在 Go 和 JS 之间来回转整个状态，方向也和「服务端是 Go」相反。

**把网页挪进 `archive/`。** 挪过去的代码没人构建、没人测，会悄悄坏掉，留着只是让人以为它还能用；git 历史里随时能找回。

## Consequences

- 改一条规则只改 Go 一处；改形状仍然要重新导出、生成 Go 和 Dart 的类型。（后来形状也写在 Go 里，`go run ./tool/shapegen` 一步写出两边，见 [形状的源头是 Go](../architecture/2026-10-15-go-owns-the-shapes.md)。）
- 没有不起服务端就能调的画面了：调 Flutter 要开一个 Go 服务端（`go run ./cmd/server`，或 macOS 应用自带的那个）。
- 黄金数据不再有独立的第二份实现来对：Go 的规则有意改了，`-update` 会照单全收，靠看 diff 和直接写的规则测试把关。
- Flutter 的 `lib/rules/` 里还有从 TypeScript 移植来的一部分显示规则（阶段的说法、计划的布局……），出处注释指向的 TypeScript 已经删了；它们和 Go 的同名规则没有对照测试守着，是第三份。往后要么由服务端在帧里算好发过来，要么接受它们只是画面上的说法。
- 不少代码注释还写着「从网页的某某移植」：那是出处，不是依赖，没有逐个改。

## Verification

- `pnpm --filter @heybro/tools schemas:check`（当时的检查，`tools/` 后来删了）：删掉规则以后，导出的文件和删之前一样。
- `go test ./internal/protocol`：`TestReduceGolden`、`TestRulesGolden`、`TestPlayRulesGolden`、`TestSiteFrameSample`；`go test ./internal/protocol -update` 之后再跑照样通过。
- 当时的 `pnpm check`（后来随 TypeScript 删了）、`go vet ./... && go test ./...`、`bun run flutter:check`、`bun run docs:verify`。
