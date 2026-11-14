# 开发

在本机运行、检查与打包 VibeValley。命令总表与规范见根目录 [AGENTS.md](AGENTS.md)，代码分层见 [architecture.md](docs/architecture.md)。

## 跑起来

需要 Rust（`rust-toolchain.toml`）和 Vite+（`vp`：按 `.node-version` 安装 Node 24，按 `packageManager` 使用 pnpm）。帮工使用本机已安装并登录的农机（Claude Code、codex、ACP 农机）；VibeValley 自己的农机和助手只需 DeepSeek 密钥。

```bash
vp install                                   # 根目录：安装 TS 依赖
cargo run -p vibevalley-server               # 服务端：监听 127.0.0.1:8787；-- --web apps/web/dist 同时在 / 提供页面
vp run --filter @vibevalley/web build         # 构建页面（apps/web/dist）
cargo run -p vibevalley-mac                  # 原生应用（apps/mac）；改 apps/mac/ui 前先 vp run nsh:install
vp run desktop:dev                           # 过渡期的 Electron 桌面版：拉起 Rust 服务端，窗口打开 Vite 的 dev server
```

- **目录**：帮工在 `~/vibevalley-dev`（`VIBEVALLEY_WORK_ROOT`）下运行，仓库在 `repos/`，worktree 在 `worktrees/`；设置与数据在 `~/.vibevalley`（`VIBEVALLEY_HOME`），详情见[设置和配置](docs/subsystems/setting.md#模型和不变量)。
- **重载**：服务端不自动重载，修改 `crates/` 需重新构建、重启；页面修改后需重新构建（不开 `vite dev`）。
- **表结构**：各模块在打开时 `create table if not exists`（家目录的 `server.db`，工单板是 `state.db`），直接改建表语句，不写增量迁移（AGENTS.md「不留兼容」）。

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
- **发布脚本**（`scripts/release/release.ts`）：校验工作区干净、分支与 origin 一致，由已有 tag 推算下一版本号（`scripts/release/release-plan.ts`）；beta 与正式版先跑 `vp run release:verify` 并比对表结构，确认后打 tag 推送，由 `release.yml` 打包并建草稿 Release。
- **打包流程**（`apps/desktop/scripts/package.ts`）：构建页面与桌面壳，带上 cargo 构建的 `vibevalley-server` 与 `vibevalley` 两个二进制，由 electron-builder 封装进应用。`apps/mac` 的签名、公证和自动更新还没做（[原生计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)）。未签名应用首次打开需在「系统设置 → 隐私与安全性」放行。

## 检查和测试

优先运行与改动相关的最窄检查（命令总表见 [AGENTS.md](AGENTS.md#命令)）：

- `vp run rust:check`：`cargo fmt --check`、`cargo clippy --workspace --all-targets -D warnings` 与 `cargo test --workspace`（服务端、命令行、核心规则、原生应用）。
- `vp run protocol:rust:check`：从 `packages/protocol` 重新生成 Rust 类型与 artifact、pkm 的 golden，和提交的不同就失败。
- `vp run mac:check`：`apps/mac/ui` 的 nsh 类型检查与打包。
- `vp check`：全仓 TS 格式（oxfmt）、lint（oxlint，带类型）与类型检查；`vp check --fix` 自动格式化。
- `vp run packages:check`：打出各包的声明、`vp check`、各包的测试。
- `vp run web:check`：`vp check`、前端规则 vitest 与页面构建；浏览器改动先跑对应的 `e2e:component`、`e2e:integration` 或 `e2e:audit`，交付节点用 `vp run --filter @vibevalley/web e2e` 做全量自动检查。各入口只构建需要的产物，真实集成用隔离服务端与临时家目录；纯截图另跑 `e2e:visual` 并看图，见 [页面命令](apps/web/README.md#commands)。
- `vp run desktop:test`：Playwright 启动完整 Electron 应用。
- `vp run practice:check`、`vp run health:verify`：TS 的语法树实践棘轮与逃生口棘轮。
- `vp run docs:verify`：校验 Note、skill、文档链接、旧名字、用语表、词典与生成的参考表。
- **这个仓库的 `.vibevalley/check` 和 `.vibevalley/setup`**：帮工交活前服务端跑工单 worktree 里的 `.vibevalley/check`（[仓库](docs/subsystems/repo.md#怎么走)）。本仓库的 check 先去掉 `VIBEVALLEY_*` 和模型钥匙等环境变量，再跑 `vp install --frozen-lockfile`、`vp check --deny-warnings`，按改动的路径跑检查，最后跑 `docs:verify`；新 worktree 先跑 setup：`vp install --frozen-lockfile` 和 `vp run packages:build`。

测试不连接真实模型：服务端的测试在 `crates/vibevalley-server/tests`，助手用替身模型，帮工用 oar 的 scripted 农机（`crates/vibevalley-server/src/testing.rs`）。TS 服务端的助手真模型评测随它删了，Rust 上还没有。

## 分支、提交和 PR

`main` 仅经 PR 合入，CI（`.github/workflows/ci.yml`）的各个 job 全部通过方可 squash 合并（`vp check --deny-warnings` 零警告）。开、改、合 PR 遵循 [vv-pr](.agents/skills/vv-pr/SKILL.md)。

- **分支**：`<类>/<主题>`，类别为 `feat`、`fix`、`docs`、`chore`、`refactor`、`test`，主题用英文小写连字符（如 `feat/issue-board-groups`）。
- **提交**：英文单句陈述改后行为（如 `The board groups issues by helper`），界面中文词用「」包裹，代码与路径用反引号，不超过 100 码点、不加句号，不带 AI 署名，由 `scripts/docs/commit-msg.ts` 校验。
- **钩子**：`vp install` 自动配置 `.vite-hooks/`，pre-commit 对暂存文件跑 `vp check --fix`（编辑器使用 tsrs，见 [packages/tsrs](packages/tsrs/README.md)）。
- **PR 正文**：英文填写 `## What changed`、`## Checks`（附 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 证据）、`## Not verified`。
- **回归测试**：缺陷修复测试以 `regression: ` 开头；修改或删除已有回归测试、或 `fix/` 分支无新回归测试时，须在 PR 正文加 `## Regression` 说明，由 `scripts/release/regression.ts` 检查。
- **死代码**：`vp run deadcode` 调用 knip 检查未使用的文件、导出和依赖（配置在 `knip.ts`，说明见 `scripts/audit/deadcode.ts`）。

## 改形状、规则和表

- **形状**：改 `packages/protocol/src/<概念>/shapes.ts`、`schema.ts` 和 `api.ts`，运行 `vp run protocol:rust` 重新生成 Rust 类型；改接口后再运行 `vp run api:client` 和 `vp run capabilities`。
- **规则**：服务端的规则是 `crates/vibevalley-core` 或所属模块里的纯函数，页面的在所属包里，在旁边的测试里用手写的例子写出改了的行为。
- **表**：改所属模块的建表语句（`create table if not exists`），表名照「模块_概念」。
- **旧名字**：`vp run names:verify` 检查代码与词典中的废弃命名；重命名后将旧名登记到 `scripts/docs/stale-names.ts`。

## 调试台

页面的农场按 `` ` `` 打开调试台（`apps/web/src/farm/debug/`），可控制助手与时间，查看帮工、音效、状态帧与事件。URL 加 `?tod=0.9` 可固定首页与农场的昼夜时间。

## 只用命令行派一个活

命令行是 `crates/vibevalley-cli`（二进制 `vibevalley`），仓库内用 `cargo run -p vibevalley-cli -- <命令>` 运行，桌面版带着它。默认连接 `$VIBEVALLEY_HOME/server.json` 记录的服务端或 `http://127.0.0.1:8787`，可用 `--server` 或 `VIBEVALLEY_SERVER` 覆盖。

- **设计原则**：clap，经 HTTP 用契约的类型调服务端，不替服务端做决定。路径为 `<资源> [<子资源>] <动词>`；说明按农场的语言取 `cli.*` 词典。
- **工单**：`issue list|show|create|edit|status|comment|review|diff|timeline|delete`。`issue show --watch` 持续订阅状态流直到 `in_review`、`done` 或 `canceled`。
- **其余**：`channel`、`repo`、`agent`、`session`、`runtime`、`memory`、`cron`、`artifact`、`pkm`（`capture`、`search`、`radar`、`journal`、`page`）、`worker`（帮工经 MCP 之外的汇报）、`doctor`。TS 版的 `app`、`auth`、`chat` 没有搬。
- **输出与试跑**：默认输出单行短文本（首词为后续命令要用的 ID 或编号），`--format json` 输出协议原始结构。无试跑的写命令传 `--dry-run` 返回 `NoDryRun`（退出码 `2`）。
- **错误与退出码**：失败时 stdout 为空，stderr 末行是一行 JSON，退出码按类（`crates/vibevalley-cli/src/farm.rs` 的 `exit`）；集成测试在 `crates/vibevalley-cli/tests/cli.rs`，起真的服务端。

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
python3 design/pixel/process.py         # 切全部原图到 assets/pixel/ 与 sprites.json
python3 design/pixel/process.py map plots  # 仅切指定素材
```

切图规则见[工程流程](docs/subsystems/process.md#怎么走)。应用图标位于 `assets/icons/` 与 `apps/desktop/resources/icon.icns`。音效配方在 `apps/web/src/ui/pixel/sound.ts`（[农场的皮](docs/subsystems/farm.md#模型和不变量)）。官网位于 [apps/site/README.md](apps/site/README.md)，通过 `vp run site:deploy` 部署。
