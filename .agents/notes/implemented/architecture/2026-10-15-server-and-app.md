# Agent Note: 仓库就两块：server/ 和 app/

Status: implemented

## Problem

仓库的目录还是多端时期的样子：`apps/` 下面放服务端和客户端（`apps/server-go`、`apps/flutter`），`packages/` 下面放共享的包，`tools/` 放导出脚本。几次删减以后（[一个服务端、一个客户端](.agents/notes/implemented/simplification/2026-10-14-one-server-one-client.md)、[网页退役](.agents/notes/implemented/simplification/2026-10-14-retire-the-web-page.md)、[停用代码](.agents/notes/implemented/simplification/2026-10-09-delete-site-v0.md)），`apps/` 只剩两个、`packages/` 只剩 `protocol` 一个，`tools/` 只有四个文件，而且它们都只为一件事服务：从 protocol 导出形状给 Go 和 Dart。目录名还带着已经不成立的含义：`server-go` 是和 TypeScript 服务端并存时的叫法，`packages/` 暗示有好几个共享包。

## Decision

根目录就两块，加上设计、文档和 Note：

- `server/`：Go 模块（原 `apps/server-go`）。
- 形状的源头和导出脚本（原 `packages/protocol`、`tools/`）先搬到 `server/contract/`；后来形状改由 Go 写，它们删了（[形状的源头是 Go](.agents/notes/implemented/architecture/2026-10-15-go-owns-the-shapes.md)）。
- `app/`：Flutter 客户端（原 `apps/flutter`）。
- 不变的：`design/`、`docs/`、`scripts/`、`.agents/`；根目录的 `package.json` 只剩几个命令。

搬家是 `git mv`，路径跟着改：两个 `tool/generate.sh`、打包脚本 `app/tool/build-macos.sh`、导出脚本、workspace、lint 配置、文档检查的范围、AGENTS.md、文档和 Note。生成的 Go 和 Dart 类型只有文件头里的路径变了。

## Alternatives considered

**`contract/` 放在根目录，和 `server/`、`app/` 并列。** 三块里有一块只是生成器的输入，读目录的人会以为它是第三个程序。放在 `server/` 下面说清了谁拥有接口。

**保留 `apps/` 和 `packages/`，只把 `tools/` 并进 `packages/protocol`。** 改动小，但留着两层只装一两个东西的目录，名字也还是多端时期的。

**顺便把形状的源头换成 Go，删掉 TypeScript。** 要重写 Go 和 Dart 的生成器，是另一个决定，紧接着做了（[形状的源头是 Go](.agents/notes/implemented/architecture/2026-10-15-go-owns-the-shapes.md)）。这次只搬家，不改生成链。

## Consequences

- 一眼能看出仓库是什么：一个服务端、一个客户端。
- 旧路径还留在 git 历史、一些代码注释（「从网页的某某移植」）和设计稿里，那些是出处，没有改。
- 本机的 Flutter 构建缓存带着旧的绝对路径，搬家后要 `flutter clean` 一次。

## Verification

- 搬家时跑过：`pnpm check`、`pnpm --filter @heybro/tools schemas:check`、两个 `tool/generate.sh`（产物只变文件头）、`go vet ./... && go test ./...`、`pnpm flutter:check`、`pnpm docs:verify`。pnpm、`@heybro/tools` 和 `generate.sh` 后来删了（[形状的源头是 Go](.agents/notes/implemented/architecture/2026-10-15-go-owns-the-shapes.md)），现在的检查是 `go vet ./... && go test ./...`、`bun run flutter:check`、`bun run docs:verify`。
- `pnpm package:mac`（现在是 `bun run package:mac`）打出 `app/build/vibevalley.app` 和 dmg；包里的 `vibevalley-server` 起得来，接口有应答。
