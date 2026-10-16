# 开发

这篇讲怎么在本机把 VibeValley 跑起来、怎么检查和测试、改了形状和规则怎么办、怎么打包 macOS 应用，以及客户端的调试台。代码怎么分层见 [architecture.md](architecture.md)，规矩见根目录的 [AGENTS.md](../AGENTS.md)。

## 跑起来

需要 Go 1.27、Flutter 3.47 和 Xcode（macOS 应用）；Bun 1.4 跑根目录的命令和文档检查，Node 24 只跑 `server/tool` 的两个脚本。帮工用本机装好并登录的农机：pi（`@earendil-works/pi-coding-agent`，smith 用一个内嵌的 Node 宿主跑它）、Claude Code、codex；VibeValley 自己的农机和管家只要 DeepSeek 的钥匙。

```bash
# 服务端：只听 127.0.0.1:8787，读 $VIBEVALLEY_HOME/.env（--env-file 另给一个）
cd server && go run ./cmd/vibevalley

# 客户端：连开着的服务端
cd app && flutter run -d macos --dart-define=VIBEVALLEY_SERVER=http://127.0.0.1:8787
```

第一次跑 Flutter（和升级 `agora_rtc_engine` 以后）先跑 `app/tool/agora-voice-only.sh`（[app](../app/README.md#跑和打包)）。不带 `VIBEVALLEY_SERVER` 的 `flutter run` 连默认的 `http://127.0.0.1:8787`。

- 帮工在 `~/vibevalley-work`（`VIBEVALLEY_WORK_ROOT`）下干活；`cmd/vibevalley` 的设置和记录在 `~/.vibevalley`（`VIBEVALLEY_HOME`）。全部环境变量见 [architecture.md](architecture.md)「环境变量」。
- 语音要 Agora 的凭据：放进 `$VIBEVALLEY_HOME/.env`（`agora project env write ~/.vibevalley/.env`），或首页「设置」里填（[voice.md](voice.md)）。没有也能打字用。
- 服务端改了代码要重启。

## macOS 应用

```bash
bun run package:mac                                # app/build/vibevalley.app（带 Go 服务端）和 .dmg
app/tool/build-macos.sh --channel alpha   # vibevalley Alpha：自己的 bundle id 和家目录；beta 同理
```

脚本先不带 cgo 编译 Go 服务端，放进应用的 `Contents/MacOS/vibevalley-server`，再构建 Flutter 的 release 版、临时签名、打 DMG。渠道、家目录、日志在哪见 [desktop.md](desktop.md)。

## 检查和测试

```bash
cd server && go vet ./... && go test ./...   # 服务端
cd server && go test ./internal/protocol -update       # 有意改了规则：用 Go 的结果重写黄金数据，再看 diff
bun run flutter:check                                 # 生成的形状是不是最新，flutter analyze，flutter test
bun run docs:verify                                   # Agent Notes 的格式和目录、文档里的链接
```

先跑和改动有关的最窄的那个。

服务端的测试（`server/**/*_test.go`）用 smith 的 `oartest` 扮演帮工：一个真实的会话，没有程序、登录和模型，脚本照工单行事（跑命令、提交、发呆、失败、解决冲突）。每个测试在临时目录里建真的 git 仓库、数据库在内存里，模型用 `ai.FauxProvider`，声网、飞书、QQ、微信是本地的假服务，不连网、不花钱。读会话事件、读汇报、上限这几样规则是纯函数（`internal/runs/facts.go`、`runs/rules.go`），单独测，不开会话。protocol 的规则由黄金数据测（`internal/protocol/testdata/*.jsonl.gz`：几千条带种子的随机输入和规则的结果，`internal/protocol/golden_test.go` 逐条比），另有直接写的测试（`playbook_rules_test.go`……）。smith（`server/pkg/smith`）的测试也在 `go test ./...` 里一起跑。

Flutter 的测试（`app/test/`）用 `MockClient` 假扮服务端（[app](../app/README.md#测试和对照)）。解码测试用的那一帧 `app/schema/site-frame.sample.json`，和 Dart 移植的记性挑选（`app/lib/desk/shared/recall.dart`）要对上的 `app/schema/recall.sample.json`，都由 Go 写（`go test ./internal/protocol -update`）。

格式交给 `gofmt` 和 `dart format`（一行 160 字）；`scripts/` 下的检查用 Bun 直接跑，`server/tool/` 的两个脚本用 Node 24，都没有构建和 lint。

## 改形状和规则

形状和规则都在 Go 的 `server/internal/protocol`（[理由](../.agents/notes/implemented/architecture/2026-10-15-go-owns-the-shapes.md)）。形状写在 `shapes.go`（核心状态、事实、工地事件、帧、请求和回答），接口写在 `api.go`（`Handlers` 的每个方法，带 `//vibevalley:route`）。改了它们，同一个改动里：

1. `cd server && go run ./tool/shapegen` 重写 `internal/protocol/gen.go`（联合的编解码和成员表 `XMembers`、空的切片和表写成 `[]`、`{}`、枚举的值、错误类型、`Mount`）和 Flutter 的 `app/lib/gen/vibevalley.dart`（类型和 `VibeValleyApi` 客户端）。
2. `go vet ./... && go test ./...`、`bun run flutter:check`。

联合、错误、Dart 名字和可空字段怎么写，见 `tool/shapegen` 开头的说明。

改了规则：改 `server/internal/protocol/` 里的那条，`go test ./internal/protocol -update` 用 Go 的结果重写黄金数据，看 diff 是不是只改了该改的；Flutter 的 `lib/rules/` 里有它的移植的，一起改。

细节见 [server](../server/README.md#形状和规则从哪来)、[app](../app/README.md#形状从哪来)。

## 调试台

客户端里按 `` ` `` 打开调试台（`app/lib/shell/debug/`），每个按钮是 `debug_commands.dart` 里的一条命令，对着真的服务端：

| 页签 | 能做什么 |
|---|---|
| 控制 | 通话、管家、农场的钟点、进度 |
| 帮工 | 地里的每个帮工 |
| 音效 | 逐个试听合成音效，看每个的响度 |
| 事件 | 收到的帧和工地事件 |

开发和调试都连真的服务端；测试里的服务端用 `MockClient` 假的。

## 素材和音效

- 贴图：`design/pixel/` 里生图、切图，产出是 Flutter 的贴图（`app/assets/`，[framework.md](framework.md)「素材」）。改了图重跑切图，不手改 `sprites.json`。
- 音效：配方在 `app/lib/shell/sfx.dart`，调试台「音效」页试听；`test/shell_synth_test.dart` 拿 `test/fixtures/sfx.json` 逐样本比对合成的结果（[framework.md](framework.md)「音效」）。

## 官网

`site/` 是 vibevalley.dev 的静态网页：Astro 生成，样式用 Tailwind，会动的部分是 React island（动画用 Motion），Bun 管依赖。

- `bun run site:check`：查类型和模板。
- `bun run site:build`：生成到 `site/dist/`。
- `bun run site:deploy`：构建并发到 Cloudflare。要先 `bunx wrangler login`。

场景、图标、截图和像素字直接用 `app/assets/` 和 `docs/images/` 的，不另存一份；改了游戏首页的场景（`app/lib/shell/title/`），`site/src/lib/scene.ts` 跟着改。细节见 [site/README.md](../site/README.md)。

## 文档和决策

改了行为就在同一个改动里改文档（[docs/AGENTS.md](AGENTS.md)）；非平凡的决策新增或更新它的 [Agent Note](../.agents/notes/README.md)。改完跑 `bun run docs:verify`。
