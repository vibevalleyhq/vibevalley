# 工程流程

管理代码库周边的工程约束：文档分层与 Agent Notes 沉淀、`docs:verify` 九项检查、Rust 的 clippy 与测试、TS 的静态门禁、验证 skill 规范，以及像素素材流水线。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 「代码 → 静态检查 → 文字 → 人审」四层防错原则 | 根目录常驻规则条文（[AGENTS.md](AGENTS.md#规矩)） |
| 文档分层、Agent Notes 沉淀流程与 `docs:verify` 九项检查 | 文档目录规矩（[docs/AGENTS.md](docs/AGENTS.md)）与 Note 格式（[.agents/notes/README.md](.agents/notes/README.md)） |
| 死代码检查与回归测试保护 | 服务端与前端业务测试（[地基](docs/subsystems/foundation.md)、[客户端](docs/subsystems/app.md)） |
| 仓库 skill 结构（`.agents/skills/`）与验证 skill 六节规范 | 各 skill 的具体执行步骤（[.agents/skills/README.md](.agents/skills/README.md)） |
| 像素素材生成（`design/pixel/gen.sh`）与切图流水线（`process.py`） | 页面贴图加载（[农场的皮](docs/subsystems/farm.md)）与命令速查（[开发](docs/development.md#素材音效和官网)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `scripts/docs/agent-notes.ts`、`skills.ts`、`doc-links.ts` | 校验 Note 目录格式并生成 `CATALOG.md`、校验 skill 结构、校验文档链接与反引号路径（含 `.rs`、`.toml`） |
| `scripts/docs/stale-names.ts`、`glossary.ts` | 拦截已废弃旧名字、校验用语表代码名 |
| `scripts/gen/capabilities.ts`、`api-client.ts`、`primitives.ts`、`i18n.ts` | 生成并校验 `capabilities.md`、`client.ts`、`primitives.md` 与双语词典的 `catalogs.ts`；`i18n.ts check` 同步扫描 Rust 的 `t("key")` 与前端词条，缺键和未用键直接报错 |
| `scripts/audit/oxlint-plugin.ts`、`deadcode.ts` 与 `xtask/src/{boundaries,ratchets}.rs` | 仓库自定义 lint 规则、Rust 并发棘轮门禁（`SERVER_BLOCK_ON_CEILING = 78` 及零睡眠区）、`L0`–`L3` 模块边界与 `knip` 死代码检查 |
| `scripts/release/regression.ts`、`verify-server.ts` | PR 回归测试修改门禁、启动隔离沙箱服务端 |
| `Makefile` 与 `xtask/`、`vite.config.ts` 的 `mac:check` | `cargo xtask check`（fmt、clippy `-D warnings` 与测试）、`cargo xtask loom`（四个并发内核模型检验）、`cargo xtask protocol`（TS 契约与 golden）、`vp run mac:check`（原生页面 nsh 类型检查） |
| `scripts/audit/comment-review.ts` | 调用模型审查新增注释 |
| `.agents/notes/`、`.agents/skills/` | Agent Notes 目录与仓库 skills（`.claude/skills` 软链至此） |
| `design/pixel/gen.sh`、`process.py`、`design/art.sh` | 像素素材生成、去品红切格缩放脚本与原图仓库软链 |

## 模型和不变量

- **一个事实一个家**：常驻规则放根目录 `AGENTS.md`、当前架构与理由放 `docs/subsystems/*.md`、包接口放各包 `README.md`、未完成计划放 `.agents/notes/proposed/`。
- **Note 做完即沉淀并删除**：计划上线后，将长期成立的模型、不变量与放弃的路写进对应子系统文档，删除原 Note，并运行 `vp run notes:catalog`。
- **链接与反引号路径全校验**：文档链接从仓库根写起；反引号内含目录且扩展名为源码/配置的路径必须在仓库中存在（`scripts/docs/doc-links.ts` 检查）。
- **报错信息给出改法**：自定义 lint 规则与门禁报错应包含原因、`Fix:` 改法与 `See` 参考文件路径（`scripts/audit/oxlint-plugin.test.ts` 检查）。
- **静态门禁按语言分**：Rust 靠类型、clippy（`-D warnings`）和测试（`cargo xtask check`）；TS 靠严格的 TypeScript（tsrs）和 oxlint 插件（`vp check`），`apps/mac/ui` 靠 nsh 的类型检查（`mac:check`，lint 不扫它）。Rust 上的约束写成类型、clippy 规则或测试。
- **两层虚拟时钟与定向 `loom` 模型检验**：单调异步超时测试通过 `tokio/test-util`（仅限 `[dev-dependencies]`）与 `rt::current_or_global_handle()` 在 `#[tokio::test(start_paused = true)]` 下确定性推进，日历与挂钟期限通过 `Clock` / `ManualClock`（[clock.rs](crates/core/src/clock.rs)）注入，集成测试通过 `TurnGate`（[support/mod.rs](crates/server/tests/support/mod.rs)）同步轮次，替代测试中的 `std::thread::sleep` 轮询；四处纯原子并发内核（`SliceWakeGate`、`AcpTurnMachine`、`SessionGenerationTable`、`TeardownGate`）在独立子模块通过 `cargo xtask loom` 穷举线程交错，不侵入业务模块。
- **死代码零容忍，回归测试受保护**：`vp run deadcode` 拦截未使用导出与依赖。修改或删除 `regression: ` 测试，或 `fix/` 分支未补回归测试，须在 PR 正文 `## Regression` 说明（`scripts/release/regression.ts` 检查）。
- **命名一致**：展示名用 `VibeValley`；代码、目录、环境变量 `VIBEVALLEY_*` 和分支前缀 `vibevalley/` 统一用小写 `vibevalley`。

## 怎么走

**执行非平凡改动**

1. 在 `.agents/notes/proposed/<类别>/` 编写计划 Note。
2. 实现代码与测试，通过 `vp check` 和相关测试。
3. 将 Note 中成立的设计决策沉淀进 `docs/subsystems/*.md`，删除该 Note。
4. 运行 `vp run notes:catalog` 与 `vp run docs:verify`。

**防住一类重复问题（按优先级选最高层）**

1. **代码结构与类型**：通过模块边界与类型让错误写法无法编译。
2. **静态检查**：写成 oxlint 规则、结构测试或 `docs:verify` 脚本。
3. **文字与 Skill**：无法静态检查的准则写进 `AGENTS.md` 或 `.agents/skills/`。
4. **人工审查**：仅关注产品方向与架构取舍。

**生成与切分像素素材**

1. 运行 `design/art.sh` 链接 `vibevalley-art` 原图目录。
2. 运行 `design/pixel/gen.sh <名字>` 生成品红底整图到 `design/pixel/raw/`。
3. 在 `design/pixel/process.py` 登记行列与名称，运行脚本输出 `assets/pixel/` 与 `sprites.json`。

## 和谁打交道

- **根目录 `AGENTS.md` 与 `docs/`**：由 `docs:verify` 校验链接、路径、用语表和生成文档同步。
- **CI 与 Git Hooks**：提交前跑 `vp check --fix --deny-warnings`；CI 的 `check` job 跑 `vp check`、`docs:verify`、`scripts:test`、`deadcode` 和 `scripts/release/regression.ts`；Rust 工作区和原生页面由合并前本机的 `make verify` 检查，CI 不再起 macOS 机器。
- **验收 Skill**：`.agents/skills/vv-acceptance/` 提供隔离服务端沙箱（`scripts/release/verify-server.ts`）与实机验证分册。

## 为什么这样

- **优先用代码和检查拦错，报错自带 `Fix:` 与 `See`**：让 agent 看到报错即可一次改对，避免猜解法或绕过规则。
- **Note 做完即删，子系统文档是唯一长期沉淀处**：避免几十篇旧 Note 散落并与现行代码失步。
- **共用原语自动生成清单（`primitives.md`）**：从 TS 地基目录导出与首行 JSDoc 生成并由 `docs:verify` 守住，让 agent 先复用已有原语；Rust 的不在里面。
- **整张生成角色贴图，脚本确定性切图**：单张生成同一角色全部动作保证长相一致；400MB 原图放独立仓库 `vibevalley-art` 保持主仓轻量。

## 还没做的

- 高阶骨架、重复代码 lint 与流分片测试：[白皮书检查提案](.agents/notes/proposed/process/2026-10-30-whitepaper-checks-that-say-how.md)。

## 怎么验证

- `vp run docs:verify`：依次执行 9 项文档与生成物同步检查。
- `cargo xtask audit`：校验 Rust `L0`–`L3` 模块边界与并发棘轮（`SERVER_BLOCK_ON_CEILING = 78`、`no-pollster`、`no-thread-sleep-in-zeroed-zones` 等）。
- `cargo xtask loom`：对四个隔离的原子并发内核执行穷举交错模型检验。
- `vp run deadcode`：死代码扫描。
- `vp run scripts:test`：验证 lint 报错格式、沙箱、注释审查与回归门禁。
