# 开发

在本机把 VibeValley 跑起来、检查、打包。命令的总表和规矩在根目录的 [AGENTS.md](../AGENTS.md)，代码怎么分层见 [architecture.md](architecture.md)。

## 跑起来

需要 Go 1.27、Flutter 3.47、Xcode 和 Bun 1.4。帮工用本机装好并登录的农机（pi、Claude Code、codex）；VibeValley 自己的农机和管家只要 DeepSeek 的钥匙。

```bash
cd server && go run ./cmd/vibevalley     # 只听 127.0.0.1:8787，读 $VIBEVALLEY_HOME/.env
cd app && flutter run -d macos --dart-define=VIBEVALLEY_SERVER=http://127.0.0.1:8787
```

- 第一次跑 Flutter（和升级 `agora_rtc_engine` 以后）先跑 `app/tool/agora-voice-only.sh`。
- 帮工在 `~/vibevalley-work`（`VIBEVALLEY_WORK_ROOT`）下干活，设置和记录在 `~/.vibevalley`（`VIBEVALLEY_HOME`）；其余环境变量见 [architecture.md](architecture.md)「环境变量」。
- 语音的凭据见 [voice.md](reference/voice.md)；没有也能打字用。
- 服务端改了代码要重启。

## macOS 应用

```bash
bun run package:mac                      # app/build/vibevalley.app（带 Go 服务端）和 .dmg
app/tool/build-macos.sh --channel alpha  # Alpha 渠道；beta 同理
```

渠道、家目录、日志在哪见 [desktop.md](reference/desktop.md)。

## 检查和测试

先跑和改动有关的最窄的那个（命令见 [AGENTS.md](../AGENTS.md#命令)）。服务端的测试怎么写见 [server](../server/README.md#测试)，Flutter 的见 [app](../app/README.md#测试和对照)。

## 改形状、规则和表

- **形状**：改 `server/internal/protocol` 的 `shapes.go` 或 `api.go`，同一个改动里跑 `go run ./tool/shapegen`（[server](../server/README.md#形状和规则从哪来)）。
- **规则**：改 protocol 里的纯函数，`go test ./internal/protocol -update` 重写黄金数据，看 diff；Flutter 的 `lib/rules/` 有它的移植的一起改。
- **表和查询**：迁移在 `server/migrations/`（一个改动一个新文件，跑过的不再改），查询在 `server/pkg/db/queries/`；改完重跑 sqlc（[理由](../.agents/notes/implemented/architecture/2026-10-15-sqlc-queries.md)）。新表用单数名。

## 调试台

客户端里按 `` ` `` 打开（`app/lib/shell/debug/`），对着真的服务端：控制通话、管家和钟点，看帮工，试听音效，看收到的帧和事件。

## 素材、音效和官网

- 贴图在 `design/pixel/` 里生成、切图（[pixel-village.md](reference/pixel-village.md)「素材」），不手改 `sprites.json`。
- 音效配方在 `app/lib/shell/sfx.dart`（[pixel-village.md](reference/pixel-village.md)「音效」）。
- 官网见 [site/README.md](../site/README.md)；`bun run site:deploy` 构建并发到 Cloudflare。
