# Agent Note: 一个服务端、一个客户端：退役 TypeScript 服务端、Electron 和 MyGo，网页冻结

Status: implemented

## Problem

Go 服务端（[服务端用 Go 重写](../architecture/2026-10-13-go-server-on-smith.md)）和 Flutter 客户端（[客户端迁到 Flutter](../architecture/2026-10-13-flutter-client-over-ts-server.md)）都做到了和原来的一样，仓库里于是同时有两个服务端（TypeScript 的 `apps/server` 和 Go 的 `server`）、四个客户端（网页、Electron 的 `apps/desktop`、MyGo 的 `apps/mygo`、Flutter）。每改一处行为都要在两个服务端里各改一遍、在几个客户端里各接一遍；三个 macOS 应用各有各的家目录和打包脚本，主人分不清天天用的是哪一个。

## Decision

只留一个服务端、一个客户端：

- **删掉的**：TypeScript 服务端 `apps/server`，和只有它用的 `packages/ai`、`packages/agent-core`、`packages/agent`；Electron 客户端 `apps/desktop`；MyGo 桌面版 `apps/mygo`（连同它的原生语音助手）。删之前打了一个备份 zip 放在仓库外；git 历史里都有。
- **唯一的服务端**是 `server`；**唯一的客户端**是 `app`，它的 macOS 应用把 Go 服务端带在里面（`bun run package:mac`）。
- **网页冻结**：`web/` 和它用的 `packages/core`、`packages/engine` 留着，不再加功能。这一条后来被 [网页退役](2026-10-14-retire-the-web-page.md) 取代：网页和这两个包都删了，规则只留 Go 一份。
- **还是 TypeScript 的**：`packages/protocol`（形状的唯一来源，TypeScript 的 `reduce` 和规则是对照的基准）、冻结的网页、`tools/`（`@heybro/tools`：导出形状给 Go 和 Flutter 生成类型、算对照数据、`go-contract.ts` 检查正在跑的 Go 服务端）。Effect v4 的规矩只管这几处。这一条后来被 [网页退役](2026-10-14-retire-the-web-page.md) 和 [形状的源头是 Go](../architecture/2026-10-15-go-owns-the-shapes.md) 取代：这几处都删了，仓库里不再有 TypeScript 的包和 Effect，剩下的几个脚本直接用 Bun 或 Node 跑。
- **原来的农场搬过来**：`server/tool/dump-pglite.ts` 把 TypeScript 服务端的 PGlite 倒成 JSON，`vibevalley import`（`server/cmd/vibevalley/import.go`）拷家目录里的文件、把行按原来的 id 和 seq 放进 SQLite（[server/README.md](../../../../server/README.md)「从 TypeScript 服务端搬家」）。

这一篇取代了几篇已经上线的决策里「用哪个服务端、哪个桌面客户端」的部分：[桌面客户端](../architecture/2026-10-11-desktop-client.md)（Electron）、[MyGo 原型](../architecture/2026-10-13-mygo-poc.md)、[MyGo 的原生语音](../feature/2026-10-13-native-agora-voice.md)、[全部用 TypeScript 和 Effect](../architecture/2026-10-09-typescript-effect-and-oar.md)、[自己的 agent](../architecture/2026-10-12-own-agent-on-effect.md)、[ai 和 agent-core](../architecture/2026-10-12-ai-and-agent-core.md)、[管家在 pi 上](../architecture/2026-10-10-manager-on-pi.md)。

## Alternatives considered

**TypeScript 服务端和 Go 服务端并存一阵。** 对照测试守得住纯规则，守不住服务（田头的投递、帮工的会话、计划的调度）；两个服务端并存，每个改动都要改两遍，或者让一个悄悄落后。Go 的已经过了对照测试和契约检查，旧农场有 `vibevalley import` 能搬，没有理由再养一个。

**留着 Electron 或 MyGo。** 三个 macOS 应用做同一件事：菜单栏、通知、快捷键、渠道各写三遍，家目录还各不相同。Flutter 版已经有这些，还能上手机。

**网页也删掉。** 网页是逐页对照 Flutter 的参照（`app/tool/screens`），它的模拟服务器和调试台不用起服务端就能调画面，TypeScript 的 `reduce` 也是对照测试的基准；删掉省不了多少事。冻结它：不加功能，坏了才修。

**把网页挪进 `archive/`。** 那样 Go 服务端就没有页面可发、对照截图也没了参照；留在原处、写明冻结就够。

## Consequences

- 改一处行为只改一个服务端和一个客户端。改 protocol 的形状或规则仍要重新生成 Go 和 Dart 的类型、重新生成对照数据；只要网页还在，TypeScript 的 `reduce` 就要和 Go 的保持一致。（后来网页和 TypeScript 的 `reduce` 都删了：改形状跑 `go run ./tool/shapegen`，有意改了规则用 `go test ./internal/protocol -update` 重写黄金数据，见 [形状的源头是 Go](../architecture/2026-10-15-go-owns-the-shapes.md)。）
- 冻结的网页会慢慢落后：Flutter 上新加的功能网页上没有。（网页后来删了，见 [网页退役](2026-10-14-retire-the-web-page.md)。）
- 用 pi 的帮工仍然要机器上有 Node（smith 内嵌的 Node 宿主）；管家不能再跑在 pi 上（`VIBEVALLEY_FOREMAN_RUNTIME=pi` 被拒绝）。
- **Electron 版有、Flutter 版不再有的**：打开时先看 8787 上有没有农场、有就直接用（Flutter 总在一个空闲的端口起自己的服务端，调试时用 `--dart-define=VIBEVALLEY_SERVER` 连别的）；按提交数编的版本号。
- **家目录换了**：Flutter 应用的家是 `~/Library/Application Support/vibevalley`（渠道各自一份），不是 TypeScript 服务端的 `~/.heybro`；在 Electron 版或终端里用过的农场要 `vibevalley import` 一次才在新应用里。
- 删掉的代码要看只能翻 git 历史或仓库外的备份。

## Verification

- 删掉以后仓库里的检查不依赖被删的包：当时的 `pnpm check`、`pnpm test`（protocol、core、网页，后来随 TypeScript 一起删了），和 `go vet ./... && go test ./...`、`bun run flutter:check`、`bun run docs:verify`。
- `internal/farm/import_test.go` 把一份倒出来的数据导进 SQLite，id、seq、自增和拷过去的文件都对得上；已经有农场的家目录不加 `--force` 不导。
