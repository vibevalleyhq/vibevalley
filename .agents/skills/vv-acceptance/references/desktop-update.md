# 验收桌面版打包与启动

[验收](.agents/skills/vv-acceptance/SKILL.md)的一份分册：Go 原生桌面壳（`cmd/vibe-desktop`）通过 `mygo`、WebView 与灵动岛运行，`vp run desktop:test` 覆盖内嵌栈与 `thin_desktop` 两套构建，`vp run package:mac` 产出单二进制 `dist/vibe-desktop`，`--headless-check` 在不弹窗口的条件下检查各子系统。

## 什么时候用

- 改了 `cmd/vibe-desktop/**`（`main.go`、`webview.go`、`island.go`、`terminal.go`、`embedded_stack.go`、`host_bridge.go`、`keychain.go`、`ipc.go`、`automation.go`）。
- 改了 `package.json` 里的 `desktop:dev`、`package:mac`，或 `.github/workflows/release.yml`。

不用它：只改了界面组件样式（走 `apps/web` 的故事与 Playwright 即可）。

## 准备

1. `vp run web:check`（确保页面检查过，`apps/web/dist` 最新）。
2. `env -u GOROOT CGO_ENABLED=0 go vet ./...` 与 `env -u GOROOT CGO_ENABLED=0 go vet -tags thin_desktop ./cmd/vibe-desktop/...`。

## 步骤

1. 跑两套构建下的桌面端单元测试：

   ```bash
   vp run desktop:test
   ```

2. 按发布方式编译单二进制，并做无头自检（使用临时家目录，不碰 `~/.vibevalley`）：

   ```bash
   vp run package:mac
   HOME=$(mktemp -d) ./dist/vibe-desktop --headless-check
   ```

3. 跨平台发布的构建在 `CGO_ENABLED=0` 下也必须能编过（写到临时目录，验完删除）：

   ```bash
   env -u GOROOT CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags='-s -w' -o /tmp/vibe-desktop-darwin ./cmd/vibe-desktop
   ```

## 证据

- `vp run desktop:test` 两轮（默认内嵌栈与 `-tags thin_desktop`）全部通过。
- `dist/vibe-desktop --headless-check` 输出的 JSON 自检结果及退出码 0，加上 stripping 后的二进制体积。

## 出错时

- **`--headless-check` 报 `webview` 或 `island` 失败**：先确认 `apps/web/dist` 已构建，且内嵌或外部 Web 资源目录可访问。
- **`thin_desktop` 编译失败**：检查是否误把仅用于内嵌栈的符号放进了无 tag 文件，应在 `embedded_stack.go` 与 `embedded_stack_stub.go` 之间对齐签名。

## 收拾

- 验证完删除打包产物与临时目录：`rm -f dist/vibe-desktop /tmp/vibe-desktop-darwin`，避免留下未跟踪构建文件。
