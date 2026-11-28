# 开发

在本机运行、检查与发版 VibeValley。命令总表与规范见根目录 [AGENTS.md](AGENTS.md)，代码分层见 [architecture.md](docs/architecture.md)。

## 跑起来

需要 macOS、Rust（`rust-toolchain.toml`）和 Vite+（`vp`：按 `.node-version` 安装 Node 24，按 `packageManager` 使用 pnpm）。帮工使用本机已安装并登录的农机（Claude Code、codex、ACP 农机）；VibeValley 自己的农机和助手只需 DeepSeek 密钥。

```bash
vp install                                   # 根目录：安装 TS 依赖，打出各包的声明
vp run nsh:install                           # 把 nsh 的命令行装到 .tools/bin（打页面的包要用）
cargo run -p vibevalley-mac                  # 原生应用（apps/mac）：窗口，里面带着服务端（dev 默认 127.0.0.1:8790）
cargo run -p vibevalley-server               # 只跑服务端：dev 默认监听 127.0.0.1:8790（正式版 8787）
cargo run -p vibevalley-cli -- doctor        # 命令行，对着运行中的服务端
```

- **通道、端口与目录**：端口、家目录与宿主库按发布通道隔离（`release` `8787` / `~/.vibevalley` / `VibeValley`，`beta` `8788` / `~/.vibevalley-beta` / `VibeValley-beta`，`alpha` `8789` / `~/.vibevalley-alpha` / `VibeValley-alpha`，未打包的 `dev` `8790` / `~/.vibevalley-dev` / `VibeValley-dev`），可用 `VIBEVALLEY_CHANNEL`、`VIBEVALLEY_PORT`、`VIBEVALLEY_HOME`、`VIBEVALLEY_STORE` 覆盖；原生应用与单独跑的服务端都让帮工默认在 `~/vibevalley-dev`（`VIBEVALLEY_WORK_ROOT`）下干活，仓库在 `repos/`，worktree 在 `worktrees/`（[客户端](docs/subsystems/app.md#进程和服务端)、[设置和配置](docs/subsystems/setting.md#发布通道默认端口与数据目录)）。
- **重载**：服务端不自动重载，修改 `crates/` 需重新构建、重启。调试构建的应用从磁盘读 `apps/mac/ui/build/`（工作台 `App.tsx`）与 `apps/mac/ui/build-shell/`（轻量壳窗格 `ShellApp.tsx`）的页面包：改了 TSX 跑 `vp run mac:check` 重新打包，再重开应用，不用重新编译 Rust。
- **不看屏幕检查应用**：启动应用时传 `VIBEVALLEY_DEBUG_PORT=0`（或 `--remote-debugging-port=0`）打开 VDP 回环调试门，用 `vibevalley debug`（`state`、`navigate`、`ui-tree`、`screenshot`、`server-rpc` 等）或类型化 VDP JSON-RPC 驱动并校验状态，带 `--features shot` 构建时可截取 GPUI Metal 帧（[验收的应用分册](.agents/skills/vv-acceptance/references/app.md)）。

## 发版与本地构建

版本号采用三位 SemVer 并按三阶段区分后缀：`X.Y.Z-alpha.N`（alpha）、`X.Y.Z-beta.N`（beta）与 `X.Y.Z`（release，无后缀），统一记录在根目录 `package.json` 的 `"version"` 字段中，先 bump 再打包。

```bash
vp run bump -- alpha             # 递增三位版本号后的 alpha（如 0.1.0-alpha.1 → 0.1.0-alpha.2；支持 --patch / --minor / --major）
vp run bump -- beta              # 升至 beta（如 0.1.0-alpha.2 → 0.1.0-beta.1 → 0.1.0-beta.2）
vp run bump -- release           # 摘掉预发布后缀成为正式版（如 0.1.0-beta.2 → 0.1.0；若已正式版则 patch +1）

vp run build:alpha -- --bump     # 先 bump alpha，再复用 debug + VIBEVALLEY_EMBED_UI=1 + --fast 快速产出 .app、.dmg、.zip 与 release.json，并写入本地更新源（支持 --install 装入 /Applications）
vp run build:beta -- --bump      # 先 bump beta，默认先跑 make verify，再走 [profile.release] 产出 .app、.dmg、.zip 与 release.json
vp run build:release -- --bump   # 先 bump release，默认先跑 make verify，再走 [profile.release] 产出 .app、.dmg、.zip 与 release.json
```

- **本地 git 可选开关**：`bump` 与 `build:*` 默认只改根目录 `package.json` 并产出安装包，不动 git、也不推送远端触发 CI；需要本地留痕时可追加 `-- --commit`（仅提交 `package.json`）和 `-- --tag`（只打本地 `v<version>` tag，不 push），预演加 `-- --dry-run`。
- **三阶段与打包差异**：`alpha` 默认复用 `debug` 产物配合 `VIBEVALLEY_EMBED_UI=1` 内嵌 UI 字节码与 `--fast`（避免单独重建 `target/alpha`，耗时从数分钟压至数十秒；显式传 `--profile alpha` 仍可走 `Cargo.toml` 的 `[profile.alpha]`），默认跳过 `make verify`，同时产出 `.app`、`.dmg`、`.zip` 与 `release.json`（可用 `-- --no-zip` 关闭），并自动把本地 `file://.../release.json` 写入 `VibeValley-Alpha.app` 的 `Info.plist`（`VibeValleyUpdateFeed`，可用 `-- --no-local-feed` 关闭）；首次加 `-- --install` 装进 `/Applications/VibeValley-Alpha.app` 后，后续每次 `vp run build:alpha -- --bump` 即可在运行中的应用内直接检查更新、做 SHA-512 与包标识校验并原地替换重启。`beta` 与 `release` 使用 `[profile.release]`（`strip = "symbols"`、`lto = "thin"`、`codegen-units = 1`），默认先跑 `make verify`（可用 `-- --skip-verify` 跳过）并全量打包 `.app`、`.dmg`、`.zip` 和 `release.json`，且绝不读取或写入本地 `file://` 更新源。
- **打包脚本细节**：`scripts/release/package.ts` 按 `--version > HEAD 上精确 v* 标签 > 根目录 package.json "version" > "0.0.0"` 解析版本号并按版本号分流通道（`VibeValley-Alpha` / `VibeValley-Beta` / `VibeValley` / `VibeValley-Dev`）；经 `scripts/release/package-assets.ts` 过滤仅官网使用的图片，在 `scripts/release/dmg-layout.ts` 中使用 Apple 原生 `ULFO`（LZFSE）压缩与 Papertrails 风格安装器背景（`apps/mac/resources/dmg-background.png`）。本地默认 ad-hoc 签名；`--sign <Developer ID>` 指定签名身份，`--notary-profile <配置名>` 提交公证并装订票据。两个包的更新验收见[应用验收](.agents/skills/vv-acceptance/references/app.md#打包和更新)。
- **远端 tag 发版（需要时启用）**：若后续启用 GitHub 发布工作流，可用 `vp run release alpha|beta|final` 检查分支并推送 `v*` 标签。
- **公开发布**。发布任务使用 Apple 芯片 runner。打包脚本检查应用、CLI 和灵动岛的 Mach-O 架构和最低系统版本。Info.plist 的最低版本为 macOS 14.0。Developer ID 打包还应有应用分发证书及私钥。公证需要当前 runner 钥匙串中可用的 notarytool profile。GitHub 仓库变量仅提供名称。当前托管 runner 的工作流还需接入签名材料及公证凭据的装配步骤。只有当前提交有同名版本标签时，更新清单才给出该版本的 GitHub 发布页。


## 检查和测试

优先运行与改动相关的最窄检查（命令总表见 [AGENTS.md](AGENTS.md#命令)；若本机使用 `sccache`，建议配置 `SCCACHE_CACHE_SIZE=40G`，日常迭代跑 `make verify-fast`，仅在提 PR 或发版前执行一次全量 `make pr-check` / `make verify` 避免重复跑全仓套件）：

- `make rust`（`cargo xtask check`）：`cargo fmt --check`、`cargo clippy --workspace --all-targets -- -D warnings` 与 `cargo test --workspace`（服务端、命令行、核心规则、原生应用、`xtask`）。
- `make protocol`（`cargo xtask protocol`）校验 Rust 导出的 TypeScript 契约，并在临时目录生成 `note` 的 golden 与仓库逐个比较。用 `make protocol-write`（`cargo xtask protocol --write`）更新契约产物。
- `make rust-audit`（`cargo xtask audit`）运行 [boundaries.rs](xtask/src/boundaries.rs) 与 [ratchets.rs](xtask/src/ratchets.rs) 静态检查服务端 `L0`–`L3` 分层、零循环依赖、脊柱与 `apps/mac/src/` 不导入具体业务模块，以及 Rust 异步并发棘轮（纳入 `make verify`）。
- 跨层导航与 SSOT 巡检：`cargo xtask trace <op|slice|orphans>`（6 层协议到客户端追踪）、`cargo xtask map [filter] --surface`（模块 `pub`/`pub(crate)` 门面与函数复杂度热点）、`cargo xtask deps [crate|ui] --cycles --ui`（模块依赖环与 UI 跨 feature 深层导入）及 `cargo xtask ssot-check [--dupes] [--strict]`（跨端枚举镜像、宿主 DTO 旁路、环境变量漂移与结构克隆雷达）。
- `vp run mac:check` 对原生页面运行 nsh 类型检查、打包与虚拟时钟 UI 验收套件。[场景用例](apps/mac/ui/app/scenarios.test.tsx)、[交互用例](apps/mac/ui/app/interactions.test.tsx)、[主题令牌用例](apps/mac/ui/app/theme.test.tsx)与[工作区外壳用例](apps/mac/ui/workspace/workspace.test.tsx)
- `vp run ui:gallery` 启动隔离原生窗口对典型/边界场景（含工作区与农场）一键截图、校验 `dump.json` 零错误并生成离线 HTML 画廊。
- `vp check`：`apps/mac/ui` 以外的 TS 的格式（oxfmt）、lint（oxlint，带类型）与类型检查；`vp check --fix` 自动格式化。
- `vp run packages:check`：打出各包的声明、`vp check`、各包的测试。
- `vp run scripts:test`：`scripts/` 自己的测试。
- `vp run site:check`、`vp run site:build`：官网的素材和静态生成测试、构建。
- `vp run docs:verify`：校验 skill、文档链接、旧名字、用语表、词典与生成的参考表。
- 帮工交付前，服务端运行工单 worktree 的 `.vibevalley/check`。脚本清除 `VIBEVALLEY_*` 和模型钥匙等环境变量，安装锁定版本的依赖，运行 `vp check --deny-warnings`。它按改动和新增文件选择 Rust、契约、SQL、页面和软件包的检查，最后运行 `docs:verify`。新 worktree 的 `.vibevalley/setup` 安装依赖并构建软件包声明。[仓库检查](.vibevalley/check)

测试不连接真实模型：服务端的测试在 `crates/server/tests`，助手用替身模型，帮工用 oar 的 scripted 农机（`crates/server/src/fake/runtime.rs`）。页面的测试用 `nsh/test` 写在 `apps/mac/ui`，喂样例的 `Transport`；3D 纸雕农场与开场的测试在 `apps/mac/src/diorama/` 与 `apps/mac/crates/diorama/`。

CI 只在 Linux 上运行：PR 标题与正文、`vp check`、`docs:verify`、脚本与软件包测试、`deadcode` 和官网构建。Rust 工作区和原生页面不在 CI 上查（macOS 机器一次要 16 到 44 分钟）：合并前在本机跑 `make verify`，它包含 `cargo xtask check`、`cargo xtask audit`、`cargo xtask protocol`、`vp run packages:check` 和 `vp run mac:build-test`。[CI 工作流](.github/workflows/ci.yml)

## 分支、提交和 PR

`main` 仅经 PR 合入，CI（`.github/workflows/ci.yml`）的各个 job 全部通过方可 squash 合并（`vp check --deny-warnings` 零警告）。开、改、合 PR 遵循 [vv-pr](.agents/skills/vv-pr/SKILL.md)。

- **分支**：`<类>/<主题>`，类别为 `feat`、`fix`、`docs`、`chore`、`refactor`、`test`，主题用英文小写连字符（如 `feat/issue-board-groups`）。
- **提交**：英文单句陈述改后行为（如 `The board groups issues by helper`），界面中文词用「」包裹，代码与路径用反引号，不超过 100 码点、不加句号，不带 AI 署名，由 `scripts/docs/commit-msg.ts` 校验。
- **钩子**：`vp install` 自动配置 `.vite-hooks/`，pre-commit 对暂存文件跑 `vp check --fix`（编辑器使用 tsrs，见 [scripts/tsrs](scripts/tsrs/README.md)）。
- **PR 正文**：按 [writing.md](docs/style/writing.md)（STE）用英文填写 `## What changed`、`## Changelog`（按 `Added` / `Changed` / `Fixed` / `Removed` 分组）、`## Checks`（附 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 证据）与 `## Not verified`，由 `scripts/docs/commit-msg.ts --body` 校验。
- **回归测试**：缺陷修复测试以 `regression: ` 开头；修改或删除已有回归测试、或 `fix/` 分支无新回归测试时，须在 PR 正文加 `## Regression` 说明，由 `scripts/release/regression.ts` 检查。
- **死代码**：`vp run deadcode` 调用 knip 检查未使用的文件、导出和依赖（配置在 `knip.ts`，说明见 `scripts/audit/deadcode.ts`）。原生页面从 `App.tsx`、测试和故事入口追踪；Rust 生成的完整契约由 `cargo xtask protocol` 校验，不按 TS 调用方裁剪，手写重导出照常检查。`nsh check` 同时检查未用局部声明。

## 改形状、规则和表

- **形状**：改 `crates/protocol/src/contract/<概念>.rs`，运行 `cargo xtask protocol --write` 重写 `packages/protocol` 的 `shapes.gen.ts` 与 `endpoints.gen.ts`；页面要解码它的，同改手写的 `schema.ts` 和 `api.ts`（各自的测试对着生成物查）；改接口后再运行 `vp run api:client` 和 `vp run capabilities`。
- **规则**：服务端的规则是 `crates/core` 或所属模块里的纯函数，页面的在所属包里，在旁边的测试里用手写的例子写出改了的行为。
- **表和查询。** 服务端模块共用 `ServerDb`（双后端 SQLite + PostgreSQL，实体与迁移在 `crates/server/src/db/{entities,migration}/`），表名沿用「模块_概念」。宿主 `state.db` 在 [宿主存储](apps/mac/crates/workspace/src/store/mod.rs) 使用 `SeaORM` + `SeaQuery` 实体与建表迁移（[schema.rs](apps/mac/crates/workspace/src/store/schema.rs)），修改后跑 `cargo test -p vibevalley-workspace` 验证。
- **旧名字**：`vp run names:verify` 检查代码与词典中的废弃命名；重命名后将旧名登记到 `scripts/docs/stale-names.ts`。

## 只用命令行派一个活

命令行是 `crates/cli`（二进制 `vibevalley`），仓库内用 `cargo run -p vibevalley-cli -- <命令>` 运行。目标地址按 `--server` / `VIBEVALLEY_SERVER` > `$VIBEVALLEY_HOME/auth.json`（`0600`）> 当前发布通道家目录 `server.json`（未记录时回落通道默认端口：`dev` 为 `http://127.0.0.1:8790`，正式版为 `http://127.0.0.1:8787`）解析，Bearer 令牌按 `--token` / `VIBEVALLEY_REMOTE_TOKEN` > 与目标匹配的 `auth.json` 附带。

- **设计原则**：强类型 `clap`（英文 `--help`），纯 HTTP 客户端（不链接 `vibevalley-runtime`），按服务端五大业务域分目录（`crates/cli/src/domains/{work,team,collab,content,infra}`），路径为 `<资源> [<子资源>] <动词>`，不替服务端做决定；离线轨迹评测独立为可选二进制 `vibevalley-eval`（`cargo run -p vibevalley-cli --features eval --bin vibevalley-eval -- …`）。
- **工单**：`issue list|show|watch|create|edit|status|comment|review|diff|timeline|delete`。`issue show --watch` 等待直到需要用户决策或结清，`issue watch [--follow]` 流式输出工单与轨迹事件（加 `--json` 输出 JSONL）。
- **其余**：`work`（`session` 含 `events`、`repo` 含 `pr submit`、`cron`）、`team`（`agent`、`orchestrator open|stop|approval list|resolve`、`runtime`、`memory`）、`collab`（`channel` 含 `create|delete|pin|message`、`chat` 经 HTTP 与频道助手对话）、`content`（`note` 含 `doc-view|doc-append|base-view|base-upsert|base-run|file|suggestion|history|type`、`library`、`media job|input`、`attachment`）、`infra`（`auth login|whoami|status|logout`、`remote status|enable|disable|code|revoke`、`state [--watch]`、`setting get|update|validate`、`doctor`）。
- **输出与试跑**：默认输出单行短文本（首词为后续命令要用的 ID 或编号），全局 `--json` 输出协议原始结构。试跑由协议 `ENDPOINTS` 的 `dry_run` 单源驱动，无试跑的写命令传 `--dry-run` 返回 `NoDryRun`（退出码 `2`）。
- **错误与退出码**：失败时 stdout 为空，stderr 末行是一行 JSON，退出码按类（`crates/cli/src/client.rs` 的 `exit`）；集成测试在 `crates/cli/tests/cli.rs`，起真的服务端。

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

全部原始 Papertrails 素材、生成脚本与 3D 纸雕源文件存放在独立的 `vibevalley-assets` 仓库（克隆在同级目录或设 `VIBEVALLEY_ASSETS_REPO`），由 `design/sync-assets.sh` 仅同步轻量成品到 `assets/{diorama,brand,icons,avatars,engines,site}/` 并更新 `apps/mac/resources/`：

```bash
design/sync-assets.sh --all             # 在 vibevalley-assets 打包并全量同步纸雕、品牌、头像、引擎与官网产物
design/sync-assets.sh --with-avatars    # 同步品牌、图标、引擎、官网与角色头像，并重生成 macOS 通道图标和 DMG 背景
design/diorama.sh                       # 单独编译并同步 3D 纸雕场景产物到 assets/diorama/
```

素材管线见[工程流程](docs/subsystems/process.md#怎么走)。应用图标位于 `assets/icons/` 与 `apps/mac/resources/icon*.icns`。音效触发在 `apps/mac/ui/infra/sound.ts`，合成器在 `apps/mac/src/audio/`（[农场的皮](docs/subsystems/farm.md#模型和不变量)）。官网位于 [apps/site/README.md](apps/site/README.md)，通过 `vp run site:deploy` 部署。
