# Agent Note: 方案 C：从零视角收口信息架构、术语、前端双轨与 Rust Workspace

Status: proposed

## Problem

在全原生 macOS 迁移（PR #258–#262）合入 `main`（`17f9b1e6d`）之后，VibeValley 已明确成为一个**仅面向 macOS 本机单用户**的原生桌面工作台，但仓库和产品形态仍背着两层历史包袱：

1. **信息架构过重**：工作台主侧栏（[places.ts](apps/mac/ui/vv/web/app/places.ts)、[Shell.tsx](apps/mac/ui/vv/web/app/Shell.tsx)）并列 11 个一级入口，开发者调试用的 `/catalog` 占在一级主栏，AI 团队配置被切碎在 `档案`、`农机`、设置里的 `技能` 与 `记忆` 四处，`/workspace` 与 `/repos` 平行并立，`素材库`、`/artifacts` 与 `笔记` 各自抢位；设置页拆成了 12 个子页。
2. **术语体系过重**：[docs/README.md](docs/README.md) 维护 79 行词汇映射，`农机`、`档案`、`帮工`、`帮手`、`记性`、`田头`、`空位`、`串` 等内部或农场词泄漏进工作台与模型/CLI 文案，同时混着未汉化的 `Artifact`、`Inbox`。
3. **前端与包结构有移植残留与双轨漂移**：磁盘上有 11 个 0 追踪文件的旧目录（`apps/web`、`apps/mobile`、`packages/{ai,async,base-ui,bridge,engine,health,home,provider,stories}`）；工作台深埋在 `apps/mac/ui/vv/web/` 五层嵌套里；宿主壳面（`apps/mac/ui/surfaces/`，读 `tokens.ts`）与工作台（`apps/mac/ui/vv/web/`，读 `theme.json`）分成两套组件和令牌读取链路；只有原生端使用的 `packages/pkm`、`packages/artifact` 仍隔包挂着。
4. **Rust Workspace 与模块层次偏碎**：`crates/` 存在 29 个扁平 crate（含 100–600 行胶水 crate 如 `vibevalley-server-api`、`vibevalley-home`、`vibevalley-i18n`、`vibevalley-pixel`、`vibevalley-highlight`、`vibevalley-bridge`，以及只在桌面壳使用的 `terminal`/`workspace`/`pixel`/`highlight` 与核心服务端混排）；[crates/vibevalley-server/src/modules/mod.rs](crates/vibevalley-server/src/modules/mod.rs) 下 26 个模块完全平铺；[apps/mac/src/shell.rs](apps/mac/src/shell.rs) 超过 3,200 行。

## Proposal

按 4 个独立可验收的 PR 连续落地 **方案 C**，每一阶段都能单独通过完整检查并合入 `main`：

### PR 1（P1）：架构锚定、幽灵目录清理、信息架构收口与术语统一

- **磁盘清理与守卫更新**：删除 11 个 0 追踪文件的历史目录（使根目录 `vp check --deny-warnings` 无排除参数即可直接通过），更新 [glossary.ts](scripts/docs/glossary.ts) 与 [stale-names.ts](scripts/docs/stale-names.ts) 的扫描范围。
- **信息架构从 11→6 主侧栏 + 12→5 设置页**：
  - 主侧栏收口为：**农场**（顶部模式锚点） / **工作组**：`对话`、**`任务`**、**`工作区`**（原生壳直达 `/workspace`，与 `/repos` 双向互跳，共用高亮）、**`内容`**（`Desk` 内一键切 `媒体库` / `作品` / `笔记`） / **配置组**：**`团队`**（`Desk` 内一键切 `角色` / `引擎` / `技能` / `记忆`） / 底部 **`设置`**。
  - `/catalog` 移出主侧栏，保留路由与 `⌘K` 命令面板入口，并在 `设置 → 关于与数据` 下增加「开发者工具 → 打开素材图鉴」。
  - 设置页收口为 5 项：**通用与外观**、**模型与密钥**、**语音**（页内切实时通话 / MOSS Live / 听写）、**外部连接**（页内切聊天连接器 / GitHub）、**关于与数据**；保留旧路由重定向以确保农场快捷键与书签兼容。
- **全面人话化工作台术语**：更新 [docs/README.md](docs/README.md) 用语表及全部非皮肤词典、服务端提示与文档，统一使用 `主助手`、`执行会话`、`角色`、`角色模板`、`引擎`、`任务`、`任务模板`、`父任务`/`子任务`、`待办清单`、`子代理`、`作品`、`媒体库`、`记忆`、`默认频道`、`话题`、`并发上限`、`工作区`、`收件箱`；将 `帮工`、`农机`、`田头`、`记性`、`空位` 等种地隐喻严格收敛进「农场的皮」命名空间。

### PR 2（P2）：拉平前端目录、合并壳与工作台组件、收口 `packages/{pkm,artifact}`

- 取消 `apps/mac/ui/vv/web/` 洋葱嵌套，重摆为扁平清晰的 6 块：`app/`、`design/`（壳与工作台共享唯一一套令牌与基础组件）、`workspace/`（原 `surfaces/`）、`features/`、`farm/`、`infra/`。
- 让原 `surfaces/`（`Sidebar`、`GitPanel`、`Palette`、`components/`）直接共享同一套色彩/焦点环/按钮原语，消除双轨漂移。
- 将只有原生桌面使用的 `packages/pkm`、`packages/artifact` 逻辑收口进 `apps/mac/ui/`（保留 Rust 黄金样例测试与校验，详见 `2026-11-14-native-vibevalley.md`），仅保留真实跨脚本/跨包复用的 TS 包（`protocol`、`i18n`、`testkit`、`tsrs`）。

### PR 3（P3）：收拢服务端 26 模块为 6 个业务域 + 拆解 `apps/mac/src/shell.rs`

- 在 [crates/vibevalley-server/src/modules](crates/vibevalley-server/src/modules) 内按内聚域重组为 6 组：`work/`（issue、session、workplace、cron、pull、ledger）、`team/`（agent、orchestrator、memory、provider、tool、mcp）、`collab/`（channel、watch、connector、voice）、`content/`（attachment、library、media、artifact、pkm）、`skin/`（game）、`infra/`（setting、column、core），同步更新 [sqlc.yaml](sqlc.yaml)。
- 将 [apps/mac/src/shell.rs](apps/mac/src/shell.rs) 拆分为聚焦的单职责模块（项目管理、工作区面板、托管视图编排、命令面板与快捷键、窗口菜单与设置），单文件控制在合理体量。

### PR 4（P4）：合并 29 个 Rust Crate（分层保留算法增量缓存）+ 瘦身契约胶水

- 将 29 个根 crate 收拢为清晰的少数厚 crate 与明确分组：
  - 共享基础：`crates/protocol`（吸纳 `home`、`server-api`）、`crates/i18n`、`crates/core`（吸纳 `cron`、`pkm`、`artifact` 纯域规则）、`crates/git`、`crates/files`；
  - 执行与服务：`crates/runtime`（合并 `oar` + `agent`）、`crates/server`（吸纳 `http`、`bridge`、`chord` 作为 `transport/`）、`crates/cli`；
  - 富渲染：`crates/rich`（合并 `rich-ui`、`canvas`、`chart`、`genui`、`pinyin`）；
  - 重型纯 Rust 底层引擎放到 `crates/engines/{onig,pele,shiki}`（保持独立编译单元以保护 13 万行语法/图表/正则的增量编译缓存）；
  - 仅归属原生桌面应用的 crate（`terminal`、`workspace`、`pixel`、`highlight`）收入 `apps/mac/` 下作为本地子包或模块；
  - 评估并在 `packages/protocol` 内减少无实际收益的手写重复胶水层。

## Alternatives considered

- **方案 A（只做侧栏与术语表皮收口）**：风险最小，但无法消除 `apps/mac/ui/vv/web/` 深层嵌套、`surfaces/` 与工作台双轨 UI、以及 29 个碎片 crate 的长期认知税；在决定全原生 macOS 路线后已不够彻底。
- **方案 B（收口前端与服务端模块，不动 Rust Workspace）**：能改善日常开发体验，但根目录仍堆着 29 个平级 crate（包括 100 行级胶水 crate 与桌面私有 crate），新 agent 仍需先理清过重分层。
- **极端 3-Crate 大合并（把 `onig`/`pele`/`shiki` 全部揉进大 crate）**：crate 数量更少，但会把 ~13 万行罕见变动的解析/图表引擎绑进业务 crate 的编译单元，每次改 `rich-ui` 或业务代码都会拖慢 `cargo check` / `cargo test` 增量编译；因此单独归入 `crates/engines/` 组既清晰又保住编译速度。

## Acceptance criteria

- P1–P4 每个 PR 合入前均通过全量检查（`vp run docs:verify`、`vp check --deny-warnings`、`vp run deadcode`、`vp run mac:check`、`vp run rust:check`、`GOENV_VERSION=1.26.1 vp run sql:check`、`vp run protocol:check`、`vp run scripts:test`、`vp run packages:check`、`vp run site:check && vp run site:build`）。
- 每个涉及界面或桌面行为的 PR（至少 P1、P2、P3）按 `vv-acceptance` 跑通隔离沙箱实机截图验证并确认 Light/Dark 双主题一致、`dump.json` 无报错。
- 全部 4 个 PR 落地后，将长期成立的目录拓扑、分层边界和术语规则沉淀进 [architecture.md](docs/architecture.md) 与对应子系统文档，并删除本 Note。

## Risks

- **静态术语与链接守卫**：[glossary.ts](scripts/docs/glossary.ts)、[stale-names.ts](scripts/docs/stale-names.ts) 与 [i18n.ts](scripts/gen/i18n.ts) 强校验用语表、词典与源码标识符，改名必须锁步修改并防子串误伤（如 `#inbox`、工具名、`字符串`）。
- **回归测试与路由兼容**：旧设置或团队路由在农场 HUD（[world.rs](apps/mac/src/pixel/farm/world.rs)、[hud.rs](apps/mac/src/pixel/farm/hud.rs)）及既有 BDD 测试中被引用，P1 通过路由重定向保证兼容并在 PR 说明中逐条核验回归测试。
- **跨包与 CI 路径同步**：P2–P4 搬迁文件时需同步更新 [vite.config.ts](vite.config.ts)、[knip.ts](knip.ts)、[sqlc.yaml](sqlc.yaml)、[ui-tokens.ts](scripts/audit/ui-tokens.ts) 及 [ci.yml](.github/workflows/ci.yml) 中的路径假设。
