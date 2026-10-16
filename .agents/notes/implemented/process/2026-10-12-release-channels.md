# Agent Note: 桌面客户端分 alpha、beta、release 三个渠道打包

Status: implemented

> 打包已被取代：Electron 客户端随 [一个服务端、一个客户端](../simplification/2026-10-14-one-server-one-client.md) 删掉了。三个渠道、三个应用、渠道在构建时定死这几条照旧，现在在 Flutter 的 macOS 应用里：`app/tool/build-macos.sh --channel alpha|beta|release`、`lib/desktop/channel.dart`，bundle id 是 `dev.vibevalley.app`、`.beta`、`.alpha`，家目录是 `~/Library/Application Support/vibevalley`（`vibevalley Beta`、`vibevalley Alpha`）。端口不再按渠道分：每个应用在一个空闲的回环端口起自己的服务端。版本号不再按提交数编。下面 Electron 的细节（`app.setName`、`scripts/build.ts`、`src/channel.ts`、`pnpm package:*`、`apps/desktop/release/`、`apps/desktop/test/channel.test.ts`）是当时的做法，都随 Electron 删了。

## Problem

桌面客户端只有一种包：`heybro.app`，版本永远是 `package.json` 的 `0.1.0`，用 `~/.heybro` 和 8787。主人想一边天天用一个稳的农场，一边试刚改的东西、给别人一个先看的版本。只有一种包时，装新的就覆盖了旧的；更麻烦的是新包的数据库迁移会直接跑在天天用的农场上，出了问题没有退路。几个包都占 8787 时，后开的那个会把先开的服务端当成自己的（客户端看到端口上有农场在答应就直接用）。

## Decision

三个渠道，同一套代码，打包时选（`pnpm package:alpha|beta|release`）。行为见 [desktop.md](../../../../docs/reference/desktop.md)「渠道」，命令见 [development.md](../../../../docs/development.md)「macOS 应用」。

- **三个应用，不是一个应用的三种设置**：bundle id、应用名都不同，所以能同时装、同时开，单实例锁、登录时打开、通知各管各的。Electron 默认按 `package.json` 的 name 定数据目录和单实例锁（三个渠道一样），所以启动时按应用名另设（`app.setName`、`userData`）；第一次打包后才发现，那时 Alpha 开着正式版就开不起来。
- **家目录和端口跟着渠道走**：Alpha 用 `~/.heybro-alpha` 和 8789，Beta 用 `~/.heybro-beta` 和 8788，正式版不变。工作目录共用：项目是主人的，哪个农场干都一样。`HEYBRO_HOME`、`HEYBRO_PORT` 仍然能改，想让 Beta 用正式版的数据就设它们。
- **渠道在构建时定死**：`scripts/build.ts` 把 `process.env.HEYBRO_CHANNEL` 替换成常量，打出来的应用不读环境里的渠道，不会被一个环境变量换了身份。`src/channel.ts` 没有依赖，打包脚本和客户端用同一张表。
- **版本号**：正式版是 `package.json` 的版本，发版时手改；Beta、Alpha 是它的预发布版，后面接提交数（`0.1.0-beta.412`）。提交数在一个分支上只增不减，不用另存一个构建号，越新的包版本越大。工作区有改动时 Alpha、Beta 照打，版本带 `.dirty`；正式版拒绝，除非 `--allow-dirty`。
- **一眼分得出**：Alpha、Beta 的图标右下角有带子（打包时从正式版的图标画出来），窗口标题和菜单栏后面写渠道。

## Alternatives considered

**一个应用，启动后在设置里切渠道。** 数据和端口可以跟着切，但同一时间只能开一个，新版本的代码也会跑在旧数据上，正是要避免的。

**三个渠道共用 `~/.heybro`。** 试 Beta 时能看到真的农场，但一个渠道的迁移会把库改成另一个渠道读不了的样子，两个同时开还会抢同一个数据库目录。需要时用 `HEYBRO_HOME` 手动指过去，默认分开。

**版本号用日期或另存的构建计数。** 日期在一天里打几次会重；另存计数要有个地方记、要同步。提交数现成、单调。

**git 标签决定版本。** 正式版应该打标签，但这一步留给人做：脚本不替主人推标签。

## Consequences

- 三个渠道各自有一份田头、帮工、账本和 `.env`：新装的 Alpha、Beta 要重新填语音凭据和帮工档案。
- 语音快捷键一样，先开的占着，后开的在日志里说一声，没有另配。
- 打包产物按渠道放在 `apps/desktop/release/<channel>/`。
- 正式版的数据目录从 `@heybro/desktop` 换成了 `heybro`：页面存在浏览器里的小偏好（皮肤、看过的提示）会重来一次，农场的数据不在这里，不受影响。

## Verification

- `apps/desktop/test/channel.test.ts`：三个渠道的 bundle id、应用名、家目录、端口两两不同；正式版保持 `~/.heybro` 和 8787；版本号的写法。
- 打过一个 Alpha：`heybro Alpha.app` 的 bundle id 是 `dev.heybro.farm.alpha`，版本 `0.1.0-alpha.15.dirty`；冒烟（临时家目录，不设端口）起在 8789，服务端是它自己起的，页面上有桥。
- 有改动时 `pnpm package:release` 在构建前就停下；`HEYBRO_CHANNEL` 写错时构建报错。

## Deferred

- 签名、公证和按渠道的自动更新（Beta 收 Beta 的更新）。
- 把打出来的包传到某处、发版记录。
