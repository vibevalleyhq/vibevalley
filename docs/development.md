# 开发

在本机运行、检查与打包 VibeValley。命令总表与规范见根目录 [AGENTS.md](AGENTS.md)，代码分层见 [architecture.md](docs/architecture.md)。

## 跑起来

需要 Vite+（`vp`：按 `.node-version` 安装 Node 24 与 pnpm 12）以及 Go（执行 Go 命令统一使用 `env -u GOROOT CGO_ENABLED=0 go ...`）。帮工使用本机已安装并登录的农机（pi、Claude Code、codex）；助手只需 DeepSeek 密钥。

```bash
vp install                                   # 根目录：安装全部 TS workspace 依赖
vp run --filter @vibevalley/web build        # 构建页面（apps/web/dist）
env -u GOROOT CGO_ENABLED=0 go run ./cmd/vibe-server --web apps/web/dist   # 监听 127.0.0.1:8787，读配置，在 / 提供页面
vp run desktop:dev                           # 桌面版：运行 Go 原生桌面壳 cmd/vibe-desktop
```

- **目录**：帮工在 `~/vibevalley-dev`（`VIBEVALLEY_WORK_ROOT`）下运行，仓库在 `repos/`，worktree 在 `worktrees/`；设置与数据在 `~/.vibevalley`（`VIBEVALLEY_HOME`），详情见[设置和配置](docs/subsystems/setting.md#模型和不变量)。
- **语音**：凭据配置见 [语音](docs/subsystems/voice.md)，未配置时仍可文字交互。
- **重载**：Go 服务端不自动重载，修改 Go 代码后需重启；页面修改后需重新构建（或开发模式下开 Vite dev server）。
- **表结构**：按域编辑 `internal/domain/<域>/migrations/0001_init.up.sql`（及 `internal/durable/store/`、`internal/vault/`）与对应 `queries.sql`，并运行 `vpx scripts/gen/go-sqlc.ts` 生成 `sqlcgen/` 绑定（`sqlc_migrate_test.go` 与 `go-sqlc.ts --check` 校验）。

## 桌面可执行文件与发版

```bash
vp run package:mac       # 编译并剥离符号输出至 dist/vibe-desktop
vp run release alpha     # 在 main 上打下一个 alpha
vp run release beta      # 首次在 main 切出 release/x.y 并打 beta.1；之后在 release/x.y 打下一个 beta
vp run release final     # 在 release/x.y 打正式版（须先有同版本 beta）
```

- **三阶段发版**（[客户端](docs/subsystems/app.md#发布渠道)）：
  - `alpha`：自用，功能可变。
  - `beta`：冻结功能只修缺陷，同一 `release/x.y` 线内表结构不变；修复先进 `main` 再 cherry-pick 到 `release/x.y`。
  - `final`：与最后一个 beta 使用同一份代码。
- **发布脚本**（`scripts/release/release.ts`）：校验工作区干净、分支与 origin 一致，由已有 tag 推算下一版本号（`scripts/release/release-plan.ts`）；beta 与正式版先跑 `vp run release:verify` 并比对迁移脚本目录（`internal/**/migrations/*.sql`），确认后打 tag 推送，由 `.github/workflows/release.yml` 打包并建草稿 Release。

## 检查和测试

优先运行与改动相关的最窄检查（命令总表见 [AGENTS.md](AGENTS.md#命令)）：

- `vp check`：全仓格式（oxfmt）、lint（oxlint，带类型）与 TS 类型检查；`vp check --fix` 自动格式化。
- `vp run server:check`：`packages:build`、`vp check`、`go-sqlc.ts --check`、`go-contract.ts --check`、`go vet` 与 `go test ./...`。
- `vp run web:check`：`vp check`、前端规则 vitest 与页面构建；浏览器改动先跑对应的 `e2e:component`、`e2e:integration` 或 `e2e:audit`，交付节点用 `vp run --filter @vibevalley/web e2e` 做全量自动检查。各入口只构建需要的产物，真实集成用隔离 `vibe-server` 与临时家目录；纯截图另跑 `e2e:visual` 并看图，见 [页面命令](apps/web/README.md#commands)。
- `vp run desktop:test`：测试 Go 桌面壳（常规与 `thin_desktop` 构建标签）。
- `vp run docs:verify`：校验 Note、skill、文档链接与旧名字。
- **这个仓库的 `.vibevalley/check` 和 `.vibevalley/setup`**：帮工交活前服务端跑工单 worktree 里的 `.vibevalley/check`（[仓库](docs/subsystems/repo.md#怎么走)）。本仓库的 check 按改动的路径跑 Go 检查（`go vet`、`go test`）、`server:check`、`web:check`，最后跑 `docs:verify`、`practice:check`、`health:verify` 与 `deadcode`。

测试不连接真实模型：Go 测试与隔离验收脚本在 `VIBEVALLEY_TEST_RUNTIMES=1` 下使用 `internal/domain/gateway/issue_helpers.go` 与 `pkg/oar/replaytest` 驱动脚本化帮工。

## 分支、提交和 PR

`main` 仅经 PR 合入，CI（`.github/workflows/ci.yml`）的 `check`、`server`、`web`、`desktop`、`site` 全部通过方可 squash 合并（`vp check --deny-warnings` 零警告）。开、改、合 PR 遵循 [vv-pr](.agents/skills/vv-pr/SKILL.md)。

- **分支**：`<类>/<主题>`，类别为 `feat`、`fix`、`docs`、`chore`、`refactor`、`test`，主题用英文小写连字符（如 `feat/issue-board-groups`）。
- **提交**：英文单句陈述改后行为（如 `The board groups issues by helper`），界面中文词用「」包裹，代码与路径用反引号，不超过 100 码点、不加句号，不带 AI 署名，由 `scripts/docs/commit-msg.ts` 校验。
- **钩子**：`vp install` 自动配置 `.vite-hooks/`，pre-commit 对暂存文件跑 `vp check --fix`（编辑器使用 tsrs，见 [packages/tsrs](packages/tsrs/README.md)）。
- **PR 正文**：英文填写 `## What changed`、`## Checks`（附 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 证据）、`## Not verified`。
- **回归测试**：缺陷修复测试以 `regression: ` 开头；修改或删除已有回归测试、或 `fix/` 分支无新回归测试时，须在 PR 正文加 `## Regression` 说明，由 `scripts/release/regression.ts` 检查。
- **死代码**：`vp run deadcode` 调用 knip 检查未使用的文件、导出和依赖（配置在 `knip.ts`，说明见 `scripts/audit/deadcode.ts`）。

## 改形状、规则和表

- **形状**：改 `packages/protocol/src/<概念>/shapes.ts`、`schema.ts`（`Codec<T.X>`）和 `api.ts`；改接口后运行 `vp run api:client` 和 `vp run capabilities`；改了 Go `pkg/contract` 结构后运行 `vpx scripts/gen/go-contract.ts` 并跑 `internal/domain/gateway/contract_parity_test.go`。
- **规则**：改所属包内的纯函数（跨端共用的放 `packages/protocol/src/rules`），在旁边的测试里用手写的例子写出改了的行为（[客户端问服务端](docs/subsystems/app.md)）。
- **表和查询**：改各 Go 域 `migrations/0001_init.up.sql` 与 `queries.sql`，运行 `vpx scripts/gen/go-sqlc.ts`。
- **旧名字**：`vp run names:verify` 检查代码与词典中的废弃命名；重命名后将旧名登记到 `scripts/docs/stale-names.ts`。

## 调试台

农场页按 `` ` `` 打开调试台（`apps/web/src/farm/debug/`），可控制通话、助手与时间，查看帮工、音效、状态帧与事件。URL 加 `?tod=0.9` 可固定首页与农场的昼夜时间。

## 只用命令行派一个活

命令行在 `cmd/vibe/`，仓库内通过 `env -u GOROOT CGO_ENABLED=0 go run ./cmd/vibe` 运行。默认连接 `$VIBEVALLEY_HOME/server.json` 记录的服务端或 `http://127.0.0.1:8787`，可用 `--server` 覆盖。

- **设计原则**：基于 cobra（`cmd/vibe/main.go`）与 HTTP API 客户端（`cmd/vibe/client.go`），支持 `--json` 输出。路径为 `<资源> [<子资源>] <动词>`（如 `issue`、`channel`、`pkm`、`auth`、`doctor`、`app`、`chat`）。
- **工单**：`vibe issue list|get|create|status|delete`。
- **笔记**：`vibe pkm capture`、`vibe pkm search`、`vibe pkm page list|show`。
- **桌面与诊断**：`vibe doctor` 检查家目录、`server.json`、`/healthz`、`git` 与 `PATH` 上农机；`vibe app` 控制本地桌面端。

```bash
vibe issue create … --repo clock --agent docs --json
vibe issue status <id> todo --json
vibe issue get <id> --json
vibe issue status <id> done --json
```

沙箱脚本化验收见 [vv-acceptance/references/server.md](.agents/skills/vv-acceptance/references/server.md)。

## 素材、音效和官网

原图存放在独立的 `vibevalley-art` 仓库（克隆在同级目录或设 `VIBEVALLEY_ART`，由 `design/art.sh` 链入 `design/`）：

```bash
design/art.sh
design/pixel/gen.sh <名字>             # 生成原图；两倍密用 hd-<名字>
python3 design/pixel/process.py         # 切全部原图到 apps/web/public/pixel/ 与 sprites.json
python3 design/pixel/process.py map plots  # 仅切指定素材
```

切图规则见[工程流程](docs/subsystems/process.md#怎么走)。应用图标位于 `apps/web/public/icons/`。音效配方在 `apps/web/src/ui/pixel/sound.ts`（[农场的皮](docs/subsystems/farm.md#模型和不变量)）。官网位于 [apps/site/README.md](apps/site/README.md)，通过 `vp run site:deploy` 部署。
