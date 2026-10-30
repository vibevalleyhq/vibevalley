# 开发

在本机把 VibeValley 跑起来、检查、打包。命令的总表和规矩在根目录的 [AGENTS.md](AGENTS.md)，代码怎么分层见 [architecture.md](docs/architecture.md)。

## 跑起来

需要 Vite+（`vp`）：它照 `.node-version` 装 Node（24），照 `packageManager` 用 pnpm。帮工用本机装好并登录的农机（pi、Claude Code、codex）；VibeValley 自己的农机和管家只要 DeepSeek 的钥匙。

```bash
vp install                                   # 根目录：装全部 workspace 的依赖
vp run --filter @vibevalley/web build         # 页面，apps/web/dist
vp run --filter @vibevalley/server start --web ../web/dist   # 只听 127.0.0.1:8787，读 $VIBEVALLEY_HOME/vibevalley.yaml，在 / 提供页面
vp run desktop:dev                           # 或者桌面版：Electron 带着服务端起来，打开它的页面；改页面自己刷新，改服务端自己重启（同一个端口；有帮工在干活就等它们干完再重启，免得把那一轮切断）
```

- 帮工在 `~/vibevalley-dev`（`VIBEVALLEY_WORK_ROOT`）下干活：项目在 `projects/`，worktree 在 `worktrees/`；设置和记录在 `~/.vibevalley`（`VIBEVALLEY_HOME`）；其余配置见[设置和配置](docs/subsystems/setting.md#模型和不变量)。
- 语音的凭据见 [语音](docs/subsystems/voice.md)；没有也能打字用。
- 服务端不自动重载，改了 `apps/server` 要重启；页面改了要重新构建（不开 `vite dev`）。
- 改表结构：直接改 `apps/server/db/migrations/0001_schema.up.sql`，跑 `vp run --filter @vibevalley/server db:generate`，本机的旧库服务端开机时自己挪到 `db.<旧哈希>-<时间>`、新建一个（不删）；不加迁移，也不写数据搬运（AGENTS.md「不留兼容」）。

## macOS 应用

```bash
vp run package:mac       # apps/desktop/dist：VibeValley.app（mac-arm64/）、.dmg、.zip 和 release.json
git tag v0.2.0 && git push origin v0.2.0   # 发布：release.yml 打包、建草稿 Release，看过再在 GitHub 上发布
```

`apps/desktop/scripts/package.ts` 先构建页面和壳，再把 `apps/server` 连同它的生产依赖（`packages/protocol` 拷成真的文件夹）放进 `dist/stage/server`，最后由 electron-builder 把壳、`server/` 和 `web/` 一起打进应用；服务端在应用里照样用 Electron 自带的 Node 和 tsx 跑。没有签名，第一次打开要在「系统设置 → 隐私与安全性」里放行。

## 检查和测试

先跑和改动有关的最窄的那个（命令见 [AGENTS.md](AGENTS.md#命令)）：

- `vp check`：全仓库的格式（oxfmt）、lint（oxlint，带类型）和全部包的类型；`vp check --fix` 改格式。
- `vp run server:check`：`vp check`，`packages/protocol` 的规则，`apps/server` 的查询是否最新和 vitest（核心状态的折法和共用规则的黄金数据在 `apps/server/src/core/testdata`）。
- `vp run web:check`：`vp check`，engine、宿主、手机壳和页面规则的 vitest，页面能构建；`vp run --filter @vibevalley/web e2e` 构建页面再跑 Playwright（每个 worker 一个真的服务端，临时家目录，环境里没有钥匙）。
- `vp run desktop:test`：Playwright 起整个 Electron 应用。
- `vp run docs:verify`：Note、skill、链接和旧名字。

测试从不连真的模型：服务端用照脚本回答的模型（`@vibevalley/ai/testing`），帮工用 oar 的测试 runtime。管家的真模型评测（`vp run --filter @vibevalley/server evals`）要 DeepSeek 的钥匙、花钱，先问主人。

## 分支、提交和 PR

`main` 只经 PR 改，CI（`.github/workflows/ci.yml`）的 `check`、`server`、`web`、`desktop`、`site` 都过了才能合，管理员也一样；`check` 跑 `vp check --deny-warnings`，警告也不放过；每个 job 存取 Vite Task 的缓存（`node_modules/.vite/task-cache`，按 job 和分片分开，Vite+ 标为实验性）和工具链的缓存，输入没变的任务直接重放；workflow 的 token 只读，每个 action 按提交固定（`.github/dependabot.yml` 每周提 PR 跟上新版本），每个 job 20 分钟超时（CI 只跑页面的规则测试，页面的 Playwright 在本机跑：`vp run --filter @vibevalley/web e2e`；CI 不跑 `db:check`：生成器 effect-sqlc 没发布，改了 `db/` 要在有 `../effect-sqlc` 的机器上跑 `server:check`）；合并只用 squash，PR 的标题就是 `main` 上那条提交的主题、正文就是它的说明，合完分支自动删。开、改、合 PR 照 [vv-pr](.agents/skills/vv-pr/SKILL.md)。

- **分支**：`<类>/<主题>`，类是 `feat`（新行为）、`fix`、`docs`、`chore`（工具、依赖、仓库的规矩）、`refactor`、`test`（只加测试）；主题用英文小写、连字符，比如 `feat/issue-board-groups`。
- **提交**：主题用英文，一句话说改完以后代码做什么（「The board groups issues by helper」），不写「改了什么文件」「修了一下」；界面上的中文词放进「」引用，代码和路径放进反引号；最多 100 个字（按码点数），不加句号；细节、原因和取舍写进正文，和主题之间空一行。不带 agent 的署名（`Co-Authored-By: Claude`、「Generated with …」）。这几条由 `scripts/commit-msg.ts` 查：本机是 commit-msg hook，CI 查 PR 的标题、正文和分支名；Git 自己写的（`Merge`、`Revert`、`fixup!`）不查。
- **提交前**：`vp install` 时 `prepare` 跑 `vp config --hooks`，把 git 的 hook 指到 `.vite-hooks/`；pre-commit 对暂存的文件跑 `vp check --fix`（`vite.config.ts` 的 `staged`）。临时跳过一次用 `git commit --no-verify`，CI 照样会查。
- **PR**：标题和正文用英文，正文照模板（`.github/pull_request_template.md`）写三段：`## What changed`、`## Checks`（附 [acceptance](.agents/skills/acceptance/SKILL.md) 要的证据）、`## Not verified`。一个 PR 讲一件事；同一块里顺手查出来的几处小问题可以一起，每处一条。
- **回归测试**：修一个缺陷补的测试，名字以 `regression: ` 开头（`it("regression: the helper idle longest goes home", …)`），修之前失败、修之后通过。之后的 PR 删了它、或改了它（断言、选项、跳过），正文加一节 `## Regression`，逐个写出测试名和为什么；`fix/` 分支没有新的回归测试，也在这一节写为什么补不了（界面的样子用截图作证据、打包、外面的服务）。CI 用 `scripts/regression.ts` 比较 PR 和它的基线来查。
- **死代码**：`vp run deadcode`（CI 的 check 里）用 knip 查没人用的文件、导出和依赖，什么在跑写在 `knip.ts`；报出的照 `scripts/deadcode.ts` 打出的说明处理。

## 改形状、规则和表

- **形状**：改 `packages/protocol/src/shapes.ts`（类型）和 `schema.ts`（同一个形状的 Schema，以 `Codec<T.X>` 定类型，两边对不上就编不过；id 的品牌只在类型上，线上一侧是 `Wire<T.X>`），接口在 `api.ts` 的 `endpoints`。服务端和页面都直接 import，没有生成这一步。
- **规则**：改拥有它的包里的纯函数（几处都用的在 `packages/protocol/src/rules`），`vp run golden:update` 重写黄金数据（`vp run golden:update setting` 这样只重写一个模块的，不带名字重写全部），看 diff。页面不重写服务端的规则（[客户端问服务端](docs/subsystems/app.md)）。
- **表和查询**：表结构是 `apps/server/db/migrations/0001_schema.up.sql` 一个文件（直接改），查询在 `apps/server/db/queries/<表>.sql`；改完跑 `vp run --filter @vibevalley/server db:generate`。`src/base/schema.test.ts` 查表名、索引名和一张表一个查询文件。
- **旧名字**：`vp run names:verify` 查 `apps/server/src`、`apps/web/src`、`apps/web/test`、`packages/protocol/src` 里有没有已经改掉的旧名（挂在 `docs:verify` 里）；加了新名字就把它写进 `scripts/stale-names.ts`。

## 调试台

农场页里按 `` ` `` 打开（`apps/web/src/farm/debug/`），对着真的服务端：控制通话、管家和钟点，看帮工，试听音效，看收到的帧和事件。开发或截图时在地址后加 `?tod=0.9`，把首页和农场的钟点固定在一天中的 0.9；不设时首页按打开时的钟点选背景。

## 只用命令行派一个活

先起服务端（见上）。另开终端，命令行在根目录是 `vp run --filter @vibevalley/server cli`；下面写成 `vibevalley`。它连这台机器上用着家目录的那个服务端（家目录的 `server.json` 写着地址，桌面版的也找得到），没有就是 `http://127.0.0.1:8787`；别的地址用 `--server` 或 `VIBEVALLEY_SERVER`。

命令行搭在 `effect/cli` 上（`apps/server/src/cli.ts`、`src/cli/`），接口表里每个接口是一条命令，命令的词就是操作名（`issue.create` 是 `issue create`，`issue.status.update` 是 `issue status update <id>`，操作名里的大写写成 `-`：`issue preview-delete`），`about` 的字段（多是 `<id>`）是位置参数；`vibevalley --help`、`vibevalley issue --help`、`vibevalley issue status update --help` 列出命令和参数。它的输出是给脚本和 agent 读的：

- **stdout 只放结果**：一个 JSON 文档（终端里排开，不是终端时一行）；`state --watch`、`events` 一行一帧。失败时 stdout 是空的。
- **输入** `--json` 收 JSON 文本、`-`（读标准输入）或 `@文件`，和位置参数并成一份，发出去以前照接口的 Schema 查一遍，对不上就不发，说是哪个字段；输入只有位置参数的命令不收 `--json`。
- **试跑** `--dry-run`：会删、会合、会关、会让帮工走的命令（接口表里带 `dryRun` 的：`issue status update`、`issue act` 和每一个删除，`cli.test.ts` 查每个 `delete` 都有）只回答会做什么（`{"does":[…]}`），什么都不动；它和真做走同一处判断，所以真做会拒的，试跑也拒、话一样。只读的命令照常跑；别的改东西、还没有试跑的命令带着 `--dry-run` 会被拒（`NoDryRun`），不会悄悄做了。
- **失败**是 stderr 最后一行的 JSON：`{"error":{"tag":…,"message":…,"next":[{"say":…,"run":[…]}]}}`，`next` 是接着能做什么，`run` 是能直接跑的命令（不带 `vibevalley`）：找不到的（`Missing`）总说去哪儿找（列出它们的命令），工单和计划的拒绝给出它们现在能做的动作。退出码分得出是哪一种：

  | 退出码 | 意思 |
  |---|---|
  | 0 | 成功，或要了帮助 |
  | 1 | 服务端出错 |
  | 2 | 命令写错了：不认的参数、少参数、请求体不对 |
  | 3 | 服务端拒绝（`Refused`，和语音、连接器、连接到本机的拒绝） |
  | 4 | 没有这个东西（`Missing`） |
  | 5 | 连不上服务端 |
  | 130 | 按了 Ctrl+C：`state --watch`、`issue work` 放下请求再走 |

1. 建工单。把 `…` 换成标题和项目，用返回的工单 ID 替换后面的 `<id>`。

   ```bash
   vibevalley issue create --json '{"title":"…","project":"…","assignee":"codex"}'
   ```

2. 派活。命令把备选挪到待办，等帮工交回来，再打出改动。

   ```bash
   vibevalley issue work <id>
   ```

3. 如果不满意，写清要改什么，再干一轮。

   ```bash
   vibevalley issue status update <id> --json '{"status":"todo","text":"…"}'
   ```

   反复运行下面的命令。先等 `status` 变成 `in_progress`，再等它回到 `in_review`。

   ```bash
   vibevalley issue get <id>
   ```

4. 如果满意，收下改动。先试跑，看它会怎么交付（合进主分支还是开 PR、合之前跑不跑检查）；再去掉 `--dry-run` 真做。

   ```bash
   vibevalley issue status update <id> --dry-run --json '{"status":"done"}'
   vibevalley issue status update <id> --json '{"status":"done"}'
   ```

状态规则和理由见子系统 [工单](docs/subsystems/issue.md#怎么走)。不派真的帮工、在隔离的沙箱里把这几步走一遍，见 [acceptance/server.md](.agents/skills/acceptance/server.md) 的 `--scripted-helper`。

## 素材、音效和官网

原图在单独的 vibevalley-art 仓库。把它克隆到这个仓库旁边，或用 `VIBEVALLEY_ART` 指到它的位置，再让 `design/art.sh` 把原图目录链接进 `design/`。生成和切图：

```bash
design/art.sh
design/pixel/gen.sh <名字>             # 生成一张原图；两倍密用 hd-<名字>
python3 design/pixel/process.py         # 切全部已有原图
python3 design/pixel/process.py map plots  # 只切指定素材
```

`process.py` 按各类素材的配置去品红、切格、缩放和调色，写出 `apps/web/public/pixel/` 和 `sprites.json`；不手改生成物。切图规则、按钮图标的参考图和为什么这样分工见[工程流程](docs/subsystems/process.md#怎么走)。

应用图标的原图用 `design/pixel/gen.sh app-icon` 生成。页面和官网用 `apps/web/public/icons/` 里的 `app-32.png`、`app-64.png`、`app-256.png`，桌面应用用 `apps/desktop/resources/icon.icns`。

音效配方在 `apps/web/src/ui/pixel/sound.ts`，合成和响度见[农场的皮](docs/subsystems/farm.md#模型和不变量)。官网见 [site/README.md](site/README.md)；`vp run site:deploy` 构建并发到 Cloudflare。
