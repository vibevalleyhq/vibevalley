# 开发

在本机运行、检查与打包 VibeValley。命令总表与规范见根目录 [AGENTS.md](AGENTS.md)，代码分层见 [architecture.md](docs/architecture.md)。

## 跑起来

需要 Vite+（`vp`）：按 `.node-version` 安装 Node（24），按 `packageManager` 使用 pnpm。帮工使用本机已安装并登录的农机（pi、Claude Code、codex）；VibeValley 自己的农机和管家只需 DeepSeek 密钥。

```bash
vp install                                   # 根目录：安装全部 workspace 依赖
vp run --filter @vibevalley/web build         # 构建页面（apps/web/dist）
vp run --filter @vibevalley/server start --web ../web/dist   # 监听 127.0.0.1:8787，读 $VIBEVALLEY_HOME/vibevalley.yaml，在 / 提供页面
vp run desktop:dev                           # 桌面版：Electron 拉起服务端并打开页面；改页面自动刷新，改服务端空闲时自动重启
```

- **目录**：帮工在 `~/vibevalley-dev`（`VIBEVALLEY_WORK_ROOT`）下运行，仓库在 `repos/`，worktree 在 `worktrees/`；设置与数据在 `~/.vibevalley`（`VIBEVALLEY_HOME`），详情见[设置和配置](docs/subsystems/setting.md#模型和不变量)。
- **语音**：凭据配置见 [语音](docs/subsystems/voice.md)，未配置时仍可文字交互。
- **重载**：独立运行时服务端不自动重载，修改 `apps/server` 需重启；页面修改后需重新构建（不开 `vite dev`）。
- **表结构**：直接修改 `apps/server/db/migrations/0001_schema.up.sql` 并运行 `vp run --filter @vibevalley/server db:generate`。开机时若哈希变化，旧库自动移至 `db.<旧哈希>-<时间>` 并建新库，不写增量迁移（AGENTS.md「不留兼容」）。

## macOS 应用

```bash
vp run package:mac       # apps/desktop/dist：VibeValley.app（mac-arm64/）、.dmg、.zip 和 release.json
vp run release alpha     # 在 main 上打下一个 alpha
vp run release beta      # 首次在 main 切出 release/x.y 并打 beta.1；之后在 release/x.y 打下一个 beta
vp run release final     # 在 release/x.y 打正式版（须先有同版本 beta）
```

- **三阶段发版**（[客户端](docs/subsystems/app.md#发布渠道)）：
  - `alpha`：自用，功能可变、数据库可能重建。
  - `beta`：冻结功能只修缺陷，同一 `release/x.y` 线内表结构不变；修复先进 `main` 再 cherry-pick 到 `release/x.y`。
  - `final`：与最后一个 beta 使用同一份代码。
- **发布脚本**（`scripts/release.ts`）：校验工作区干净、分支与 origin 一致，由已有 tag 推算下一版本号（`scripts/release-plan.ts`）；beta 与正式版先跑 `vp run release:verify` 并比对表结构，确认后打 tag 推送，由 `release.yml` 打包并建草稿 Release。
- **打包流程**（`apps/desktop/scripts/package.ts`）：构建页面与桌面壳，用 `vp pack` 将服务端与 CLI 打成独立包放入 `dist/stage/`，由 electron-builder 封装进应用。未签名应用首次打开需在「系统设置 → 隐私与安全性」放行。

## 检查和测试

优先运行与改动相关的最窄检查（命令总表见 [AGENTS.md](AGENTS.md#命令)）：

- `vp check`：全仓格式（oxfmt）、lint（oxlint，带类型）与类型检查；`vp check --fix` 自动格式化。
- `vp run server:check`：`vp check`、`packages/protocol` 规则、`apps/server` SQL 生成检查与 vitest（黄金数据在 `apps/server/src/core/testdata`）。
- `vp run web:check`：`vp check`、前端规则 vitest 与页面构建；浏览器改动先跑对应的 `e2e:component`、`e2e:integration` 或 `e2e:audit`，交付节点用 `vp run --filter @vibevalley/web e2e` 做全量自动检查。各入口只构建需要的产物，真实集成用隔离服务端与临时家目录；纯截图另跑 `e2e:visual` 并看图，见 [页面命令](apps/web/README.md#commands)。
- `vp run desktop:test`：Playwright 启动完整 Electron 应用。
- `vp run docs:verify`：校验 Note、skill、文档链接与旧名字。

测试不连接真实模型：服务端使用脚本化模型（`@vibevalley/ai/testing`），帮工使用 oar 测试 runtime。管家真模型评测（`vp run --filter @vibevalley/server evals`）消耗 DeepSeek 额度，运行前须经主人同意。

## 分支、提交和 PR

`main` 仅经 PR 合入，CI（`.github/workflows/ci.yml`）的 `check`、`server`、`web`、`desktop`、`site` 全部通过方可 squash 合并（`vp check --deny-warnings` 零警告）。开、改、合 PR 遵循 [vv-pr](.agents/skills/vv-pr/SKILL.md)。

- **分支**：`<类>/<主题>`，类别为 `feat`、`fix`、`docs`、`chore`、`refactor`、`test`，主题用英文小写连字符（如 `feat/issue-board-groups`）。
- **提交**：英文单句陈述改后行为（如 `The board groups issues by helper`），界面中文词用「」包裹，代码与路径用反引号，不超过 100 码点、不加句号，不带 AI 署名，由 `scripts/commit-msg.ts` 校验。
- **钩子**：`vp install` 自动配置 `.vite-hooks/`，pre-commit 对暂存文件跑 `vp check --fix`（编辑器使用带 Effect 插件的 tsrs，见 [packages/tsrs](packages/tsrs/README.md)）。
- **PR 正文**：英文填写 `## What changed`、`## Checks`（附 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 证据）、`## Not verified`。
- **回归测试**：缺陷修复测试以 `regression: ` 开头；修改或删除已有回归测试、或 `fix/` 分支无新回归测试时，须在 PR 正文加 `## Regression` 说明，由 `scripts/regression.ts` 检查。
- **死代码**：`vp run deadcode` 调用 knip 检查未使用的文件、导出和依赖（配置在 `knip.ts`，说明见 `scripts/deadcode.ts`）。

## 改形状、规则和表

- **形状**：改 `packages/protocol/src/<概念>/shapes.ts`、`schema.ts`（`Codec<T.X>`）和 `api.ts`；改接口后运行 `vp run api:client` 和 `vp run capabilities`。
- **规则**：改所属包内的纯函数（跨端共用的放 `packages/protocol/src/rules`），运行 `vp run golden:update [模块]` 更新黄金数据并检查 diff（[客户端问服务端](docs/subsystems/app.md)）。
- **表和查询**：改 `apps/server/db/migrations/0001_schema.up.sql` 与 `apps/server/db/queries/<表>.sql`，运行 `vp run --filter @vibevalley/server db:generate`（`src/infra/schema.test.ts` 校验表名与索引）。
- **旧名字**：`vp run names:verify` 检查代码与词典中的废弃命名；重命名后将旧名登记到 `scripts/stale-names.ts`。

## 调试台

农场页按 `` ` `` 打开调试台（`apps/web/src/farm/debug/`），可控制通话、管家与时间，查看帮工、音效、状态帧与事件。URL 加 `?tod=0.9` 可固定首页与农场的昼夜时间。

## 只用命令行派一个活

命令行位于 `apps/cli`（入口 `src/main.ts`），仓库内通过 `vp run --filter @vibevalley/cli start` 运行，桌面端「关于 → 安装命令行」后直接运行 `vibevalley`（或 `vibevalley-beta`、`vibevalley-alpha`）。默认连接 `$VIBEVALLEY_HOME/server.json` 记录的服务端或 `http://127.0.0.1:8787`，可用 `--server` 或 `VIBEVALLEY_SERVER` 覆盖。

- **设计原则**：基于 `effect/cli` 与 `VibeValleyApi`，不加载服务端。路径为 `<资源> [<子资源>] <动词>`（`list`、`show`、`create`、`edit`、`delete` 及资源专用动词）。所有子命令均带描述与 `EXAMPLES`（`apps/cli/src/main.test.ts` 校验）。
- **工单**：`issue list|show|create|edit|status|comment|review|diff|timeline|delete`。`issue show --watch` 持续订阅状态流直到 `in_review`、`done` 或 `canceled`。
- **笔记**：`pkm capture`、`pkm search`、`pkm radar`、`pkm journal show`、`pkm page list|show|save|export|edit`（`edit` 调用 `$VISUAL` / `$EDITOR` 编辑原文并写回）。
- **桌面与诊断**：`vibevalley doctor` 检查农场、服务端、桌面端、农机、模型密钥与局域网状态；`vibevalley app status|open|quit|restart|update` 控制桌面端进程；`vibevalley chat [runtime]` 启动终端对话。
- **输出与试跑**：默认输出单行短文本（首词为后续命令要用的 ID 或编号），`--format json` 输出协议原始结构。带 `dryRun` 的破坏性命令支持 `--dry-run` 预演；无试跑的写命令传 `--dry-run` 返回 `NoDryRun`（退出码 `2`）。
- **错误与退出码**：失败时 stdout 为空，stderr 末行输出单行 JSON `{"error":{"tag":…,"message":…,"next":[{"say":…,"run":[…]}]}}`。

  | 退出码 | 含义 |
  |---|---|
  | 0 | 成功或显示帮助 |
  | 1 | 服务端内部错误 |
  | 2 | 命令用法或参数错误 |
  | 3 | 服务端拒绝（`Refused`） |
  | 4 | 目标不存在（`Missing`） |
  | 5 | 服务端或桌面端不可达 |
  | 130 | Ctrl+C 中断（`issue show --watch` 等） |

**标准工单闭环**：

1. 创建并派发工单：

   ```bash
   vibevalley issue create … --repo … --agent codex --criterion '…'
   vibevalley issue status <号> todo
   ```

2. 跟随状态直到帮工提问或交回：

   ```bash
   vibevalley issue show <号> --watch
   ```

3. 若帮工提问，评论即回答，随后继续跟随：

   ```bash
   vibevalley issue comment <号> …
   vibevalley issue show <号> --watch
   ```

4. 查看改动并验收交付：

   ```bash
   vibevalley issue diff <号>
   vibevalley issue review <号> --fail --finding …
   vibevalley issue status <号> todo --comment …
   vibevalley issue review <号> --pass
   vibevalley issue status <号> done --dry-run
   vibevalley issue status <号> done
   ```

状态流转规则见 [工单](docs/subsystems/issue.md#怎么走)，沙箱脚本化验收见 [vv-acceptance/references/server.md](.agents/skills/vv-acceptance/references/server.md)。

## 素材、音效和官网

原图存放在独立的 `vibevalley-art` 仓库（克隆在同级目录或设 `VIBEVALLEY_ART`，由 `design/art.sh` 链入 `design/`）：

```bash
design/art.sh
design/pixel/gen.sh <名字>             # 生成原图；两倍密用 hd-<名字>
python3 design/pixel/process.py         # 切全部原图到 apps/web/public/pixel/ 与 sprites.json
python3 design/pixel/process.py map plots  # 仅切指定素材
```

切图规则见[工程流程](docs/subsystems/process.md#怎么走)。应用图标位于 `apps/web/public/icons/` 与 `apps/desktop/resources/icon.icns`。音效配方在 `apps/web/src/ui/pixel/sound.ts`（[农场的皮](docs/subsystems/farm.md#模型和不变量)）。官网位于 [apps/site/README.md](apps/site/README.md)，通过 `vp run site:deploy` 部署。
