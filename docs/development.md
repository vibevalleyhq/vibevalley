# 开发

在本机把 VibeValley 跑起来、检查、打包。命令的总表和规矩在根目录的 [AGENTS.md](AGENTS.md)，代码怎么分层见 [architecture.md](docs/architecture.md)。

## 跑起来

需要 Bun 1.4 和 Node 24。帮工用本机装好并登录的农机（pi、Claude Code、codex）；VibeValley 自己的农机和管家只要 DeepSeek 的钥匙。

```bash
bun install                                  # 根目录：装全部 workspace 的依赖
bun run --filter vibevalley-web build        # 页面，apps/web/dist
cd apps/server && npm start -- --web ../web/dist   # 只听 127.0.0.1:8787，读 $VIBEVALLEY_HOME/vibevalley.yaml，在 / 提供页面
bun run desktop:dev                          # 或者桌面版：Electron 带着服务端起来，打开它的页面
```

- 帮工在 `~/vibevalley-dev`（`VIBEVALLEY_WORK_ROOT`）下干活：项目在 `projects/`，worktree 在 `worktrees/`；设置和记录在 `~/.vibevalley`（`VIBEVALLEY_HOME`）；其余配置见 [architecture.md](docs/architecture.md)「配置」。
- 语音的凭据见 [语音](docs/subsystems/voice.md)；没有也能打字用。
- 服务端不自动重载，改了 `apps/server` 要重启；页面改了要重新构建（不开 `vite dev`）。
- 改表结构：直接改 `apps/server/db/migrations/0001_schema.up.sql`，跑 `cd apps/server && npm run db:generate`，删掉本机的库让服务端重建；不加迁移，也不写数据搬运（AGENTS.md「不留兼容」）。

## macOS 应用

```bash
bun run package:mac      # apps/desktop/dist：VibeValley.app（mac-arm64/）和 .dmg
```

`apps/desktop/scripts/package.ts` 先构建页面和壳，再把 `apps/server` 连同它的生产依赖（`packages/protocol` 拷成真的文件夹）放进 `dist/stage/server`，最后由 electron-builder 把壳、`server/` 和 `web/` 一起打进应用；服务端在应用里照样用 Electron 自带的 Node 和 tsx 跑。没有签名，第一次打开要在「系统设置 → 隐私与安全性」里放行。

## 检查和测试

先跑和改动有关的最窄的那个（命令见 [AGENTS.md](AGENTS.md#命令)）：

- `bun run check`：`vp check`，全仓库的格式（oxfmt）、lint（oxlint，带类型）和类型；`bun run check:fix` 改格式。
- `bun run server:check`：`packages/protocol` 的规则和黄金数据，`apps/server` 的类型、查询是否最新和 vitest。
- `bun run web:check`：各包的类型，页面能构建；`cd apps/web && bun run test` 跑规则的 bun test 和 Playwright（每个 worker 一个真的服务端，临时家目录，环境里没有钥匙）。
- `bun run desktop:test`：Playwright 起整个 Electron 应用。
- `bun run docs:verify`：Note、skill、链接和旧名字。

测试从不连真的模型：服务端用 pi-ai 的假模型，帮工用 oar 的测试 runtime。管家的真模型评测（`cd apps/server && npm run evals`）要 DeepSeek 的钥匙、花钱，先问主人。

## 分支、提交和 PR

`main` 只经 PR 改，CI（`.github/workflows/ci.yml`）的 `check`、`server`、`web`、`desktop`、`site` 都过了才能合，管理员也一样；合并只用 squash，PR 的标题就是 `main` 上那条提交的主题，合完分支自动删。

- **分支**：`<类>/<主题>`，类是 `feat`（新行为）、`fix`、`docs`、`chore`（工具、依赖、仓库的规矩）、`refactor`；主题用英文小写、连字符，比如 `feat/issue-board-groups`。
- **提交**：主题一句话，说改完以后代码做什么（「The board groups issues by helper」），不写「改了什么文件」「修了一下」；最多 100 个字（按码点数，中文一个字算一个），不加句号；细节、原因和取舍写进正文，和主题之间空一行。不带 agent 的署名（`Co-Authored-By: Claude`、「Generated with …」）。这几条由 `scripts/commit-msg.ts` 查：本机是 commit-msg hook，CI 查 PR 的标题；Git 自己写的（`Merge`、`Revert`、`fixup!`）不查。
- **提交前**：`bun install` 时 `prepare` 跑 `vp config --hooks`，把 git 的 hook 指到 `.vite-hooks/`；pre-commit 对暂存的文件跑 `vp check --fix`（`vite.config.ts` 的 `staged`）。临时跳过一次用 `git commit --no-verify`，CI 照样会查。
- **PR**：照模板（`.github/pull_request_template.md`）写三段：改了什么、跑了哪些检查（附验证 skill 要的证据）、什么没验证。

## 改形状、规则和表

- **形状**：改 `packages/protocol/src/shapes.ts`（类型）和 `schema.ts`（同一个形状的 Schema，以 `Schema.Codec<T.X>` 定类型，两边对不上就编不过），接口在 `api.ts` 的 `endpoints`。服务端和页面都直接 import，没有生成这一步。
- **规则**：改拥有它的包里的纯函数（几处都用的在 `packages/protocol/src/rules`），`bun run golden:update` 重写黄金数据，看 diff。页面不重写服务端的规则（[客户端问服务端](docs/subsystems/app.md)）。
- **表和查询**：表结构是 `apps/server/db/migrations/0001_schema.up.sql` 一个文件（直接改），查询在 `apps/server/db/queries/<表>.sql`；改完跑 `npm run db:generate`。`src/base/schema.test.ts` 查表名、索引名和一张表一个查询文件。
- **旧名字**：`bun run names:verify` 查 `apps/server/src`、`apps/web/src`、`apps/web/test`、`packages/protocol/src` 里有没有已经改掉的旧名（挂在 `docs:verify` 里）；加了新名字就把它写进 `scripts/stale-names.ts`。

## 调试台

农场页里按 `` ` `` 打开（`apps/web/src/farm/debug/`），对着真的服务端：控制通话、管家和钟点，看帮工，试听音效，看收到的帧和事件。

## 只用命令行派一个活

先起服务端（见上）。另开终端，命令行在 `apps/server` 下是 `npm run cli --`；下面写成 `vibevalley`。它默认连 `http://127.0.0.1:8787`，别的地址用 `--server` 或 `VIBEVALLEY_SERVER`。

1. 建工单。把 `…` 换成标题和项目，用返回的工单 ID 替换后面的 `<id>`。

   ```bash
   vibevalley issue create --json '{"title":"…","project":"…","assignee":"codex"}'
   ```

2. 派活。命令把备选挪到待办，等帮工交回来，再打出改动。

   ```bash
   vibevalley issue run <id>
   ```

3. 如果不满意，写清要改什么，再干一轮。

   ```bash
   vibevalley issue status <id> --json '{"status":"todo","text":"…"}'
   ```

   反复运行下面的命令。先等 `status` 变成 `in_progress`，再等它回到 `in_review`。

   ```bash
   vibevalley issue get <id>
   ```

4. 如果满意，收下改动。服务端把改动合进主分支。

   ```bash
   vibevalley issue status <id> --json '{"status":"done"}'
   ```

状态规则和理由见子系统 [工单](docs/subsystems/issue.md#怎么走)。

## 素材、音效和官网

- 贴图在 `design/pixel/` 里生成、切图，落到 `apps/web/public/pixel`（[pixel-village.md](docs/reference/pixel-village.md)「素材」），不手改 `sprites.json`。
- 音效配方在 `apps/web/src/farm/sound.ts`（[pixel-village.md](docs/reference/pixel-village.md)「音效」）。
- 官网见 [site/README.md](site/README.md)；`bun run site:deploy` 构建并发到 Cloudflare。
