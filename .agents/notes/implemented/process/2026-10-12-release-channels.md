# Agent Note: 桌面客户端分 alpha、beta、release 三个渠道打包

Status: implemented

## Problem

桌面客户端只有一种包，版本永远是 `app/pubspec.yaml` 的 `0.1.0`，用 `~/Library/Application Support/vibevalley` 和一个固定端口。主人想一边天天用一个稳的农场，一边试刚改的东西、给别人一个先看的版本。只有一种包时，装新的就覆盖了旧的；更麻烦的是新包的数据库迁移会直接跑在天天用的农场上，出了问题没有退路。

## Decision

三个渠道，同一套代码，打包时选（`app/tool/build-macos.sh --channel alpha|beta|release`，不写是 release）。行为见 [desktop.md](../../../../docs/reference/desktop.md)「渠道」，命令见 [development.md](../../../../docs/development.md)「macOS 应用」。

- **三个应用，不是一个应用的三种设置**：应用名、bundle id 都不同，所以能同时装、同时开，单实例锁、登录时打开、通知各管各的。表在 `app/lib/desktop/channel.dart`：

  | 渠道 | 应用 | bundle id | 家目录 |
  |---|---|---|---|
  | release | `vibevalley.app`（码农场物语） | `dev.vibevalley.app` | `~/Library/Application Support/vibevalley` |
  | beta | `vibevalley Beta.app` | `dev.vibevalley.app.beta` | `~/Library/Application Support/vibevalley Beta` |
  | alpha | `vibevalley Alpha.app` | `dev.vibevalley.app.alpha` | `~/Library/Application Support/vibevalley Alpha` |

- **渠道在构建时定死**：`build-macos.sh` 把渠道放进 `flutter build --dart-define=VIBEVALLEY_CHANNEL`，打出来的应用不读环境里的渠道，不会被一个环境变量换了身份。`channel.dart` 的映射是唯一的表。
- **每个应用带自己的服务端**：Go 服务端编成 `Contents/MacOS/vibevalley-server` 放进包里，开机在一个空闲的回环端口拉起。端口不按渠道分，两个渠道同时开也不抢。
- **工作目录共用**：项目是主人的，哪个农场干都一样；`VIBEVALLEY_HOME` 仍然能改。
- **版本号**：用 `app/pubspec.yaml` 的版本，发版时手改；打包不改版本号。
- **签名**：临时签名（`codesign --sign -`），没有 Developer ID，也不公证。

## Alternatives considered

**一个应用，启动后在设置里切渠道。** 数据和端口可以跟着切，但同一时间只能开一个，新版本的代码也会跑在旧数据上，正是要避免的。

**三个渠道共用一个家目录。** 试 Beta 时能看到真的农场，但一个渠道的迁移会把库改成另一个渠道读不了的样子，两个同时开还会抢同一个数据库目录。需要时用 `VIBEVALLEY_HOME` 手动指过去，默认分开。

**端口按渠道分。** 不用探空闲端口，但端口可能被别的程序占；每个应用自己找空闲端口更省心。

**版本号用日期或提交数。** 日期在一天里打几次会重；提交数要有个地方记、要同步。现在版本号在 `pubspec.yaml`，打包不改。

## Consequences

- 三个渠道各自有一份田头、帮工、账本和 `vibevalley.yaml`：新装的 Alpha、Beta 要重新填语音凭据和帮工档案。
- 打包产物按渠道命名：`app/build/vibevalley-arm64.dmg`、`vibevalley-beta-arm64.dmg`、`vibevalley-alpha-arm64.dmg`。
- 临时签名意味着别的 Mac 第一次打开要右键打开一次；公证以后再说。

## Verification

- 打三个渠道：`app/tool/build-macos.sh --channel alpha|beta|release`，`Info.plist` 的 `CFBundleIdentifier`、`CFBundleName` 和 `.dmg` 名字跟着渠道变；应用里 `desktopChannel.productName` 决定家目录和日志目录。
- 两个渠道同时开，各自的服务端在各自的空闲端口上答 `GET /api/health`。
