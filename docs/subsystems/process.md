# 工程流程

管理代码库周边的工程约束：双层 SSOT（VibeValley Issues + `docs/subsystems/*.md`）沉淀、`docs:verify` 检查、纯 Rust 零新依赖 `xtask` 导航与 QA 门禁、TS 静态门禁、验证 skill 规范，以及 Papertrails 素材同步流水线。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 「代码 → 静态检查 → 文字 → 人审」四层防错原则 | 根目录常驻规则条文（[AGENTS.md](AGENTS.md#规矩)） |
| 双层 SSOT 沉淀流程与 `docs:verify` 检查 | 文档目录规矩（[docs/AGENTS.md](docs/AGENTS.md)） |
| 纯 Rust `xtask` 跨层导航与 QA 门禁套件（`trace`/`map`/`deps`/`ssot-check`、`crap`/`dry`/`mutate`/`uml`）、死代码与回归测试保护 | 服务端与前端业务测试（[地基](docs/subsystems/foundation.md)、[客户端](docs/subsystems/app.md)） |
| 仓库 skill 结构（`.agents/skills/`）与验证 skill 六节规范 | 各 skill 的具体执行步骤（[.agents/skills/README.md](.agents/skills/README.md)） |
| Papertrails 素材打包与同步流水线（`design/sync-assets.sh`、`design/diorama.sh`） | 场景与工作台加载（[农场的皮](docs/subsystems/farm.md)）与命令速查（[开发](docs/development.md#素材音效和官网)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `scripts/docs/skills.ts`、`doc-links.ts` | 校验 skill 结构、文档地图覆盖、仓库根路径链接与反引号源码路径（含 `.rs`、`.toml`） |
| `scripts/docs/stale-names.ts`、`glossary.ts` | 拦截已废弃旧名字、校验用语表代码名 |
| `scripts/gen/capabilities.ts`、`api-client.ts`、`primitives.ts`、`i18n.ts` | 生成并校验 `capabilities.md`、`client.ts`、`primitives.md` 与双语词典的 `catalogs.ts`；`i18n.ts check` 同步扫描 Rust 的 `t("key")` 与前端词条、拦截 `zh` 非白名单纯英文残值并核对 12 类 `ArtifactType` 全覆盖 |
| `scripts/audit/oxlint-plugin.ts`、`deadcode.ts`、`patrol.ts` 与 `xtask/src/{boundaries,ratchets,arch_audit}.rs` | 仓库自定义 lint 规则、`arch-audit` 边界与并发棘轮、`knip` 死代码检查、确定性巡检扫描与台账工具（`vp run patrol`） |
| `xtask/src/{trace,map,deps,ssot}.rs`、`xtask/src/qa/` | 纯 Rust 零新依赖跨层导航/SSOT 巡检与 QA 门禁套件（`crap`、`dry`、`mutate`、`uml`、`viewer`） |
| `scripts/release/regression.ts`、`verify-server.ts` | PR 回归测试修改门禁、启动隔离沙箱服务端 |
| `Makefile` 与 `xtask/`、`vite.config.ts` 的 `mac:check` | `cargo xtask check`（fmt、clippy `-D warnings` 与测试）、`cargo xtask loom`（四个并发内核模型检验）、`cargo xtask protocol`（TS 契约与 golden）、`vp run mac:check`（原生页面 nsh 类型检查）、`make patrol`（确定性传感器巡检） |
| `scripts/audit/comment-review.ts` | 调用模型审查新增注释 |
| `.agents/skills/` | 仓库 skills（含 `vv-governance/references/{interrogate,blast-radius,benchmark-checklist}.md` 与 `vv-patrol/`；`.claude/skills` 软链至此） |
| `design/sync-assets.sh`、`design/diorama.sh` | 从独立 `vibevalley-assets` 仓同步 Papertrails 纸雕、品牌、图标、头像、引擎与官网轻量产物并重生成 macOS 通道图标 |

## 模型和不变量

- **双层 SSOT（VibeValley Issues + `docs/subsystems/*.md`）**：
  - **VibeValley Issues**：承载尚未上线或演进中的功能、缺陷、架构、简化、流程与测试事项。Issue 需带明确的 `Category` 标签（`feature` | `bug-fix` | `architecture` | `simplification` | `process` | `testing`）、`Domain Tags`、`priority` 与可核验 `criteria`；`architecture` 类 Issue 须补充「Alternatives considered / 放弃的路」。
  - **`docs/subsystems/*.md`**：唯一的长期架构现状真源（常驻规则放根目录 `AGENTS.md`，包接口放各包 `README.md`）。非平凡改动合入主线后，将长期成立的模型、不变量与放弃的路沉淀进对应子系统文档，并在 `## 还没做的` 仅以纯文字 `#NN` 索引仍待做的 Issue。
- **链接与反引号路径全校验**：文档链接从仓库根写起；反引号内含目录且扩展名为源码/配置的路径必须在仓库中存在（`scripts/docs/doc-links.ts` 检查）。
- **报错信息给出改法**：自定义 lint 规则与门禁报错应包含原因、`Fix:` 改法与 `See` 参考文件路径（`scripts/audit/oxlint-plugin.test.ts` 检查），`xtask` 跨层导航与 SSOT 工具统一输出处方式 `--json`（`rule`、`file`、`line`、`symbol`、`why`、`fix_hint`）。
- **静态门禁按语言分**：Rust 靠类型、clippy（`-D warnings`）和测试（`cargo xtask check`）；TS 靠严格的 TypeScript（tsrs）和 oxlint 插件（`vp check`），`apps/mac/ui` 靠 nsh 的类型检查（`mac:check`，lint 不扫它）。Rust 上的约束写成类型、clippy 规则或测试。
- **质量指标报告而不设机械行数门槛**：已落地原生 `cargo xtask crap`、`dry`、`mutate`、`uml` 与 `ssot-check`（均仅支持 Rust + TypeScript/TSX，通过 Policy / Topology IR / `.metrics/` 三层隔离并共享 `(namespace, name, visibility)` 主键）；**明确放弃**外部 `ast-grep`、`jscpd`、`dependency-cruiser` 以及对文件行数、函数行数或 `3:1` 重构比例设机械硬门槛（真实稳定性与结构隐患直接按具体问题追踪，如 `#35`）。
- **两层虚拟时钟与定向 `loom` 模型检验**：单调异步超时测试通过 `tokio/test-util`（仅限 `[dev-dependencies]`）与 `rt::current_or_global_handle()` 在 `#[tokio::test(start_paused = true)]` 下确定性推进，日历与挂钟期限通过 `Clock` / `ManualClock`（[clock.rs](crates/core/src/clock.rs)）注入，集成测试通过 `TurnGate`（[support/mod.rs](crates/server/tests/support/mod.rs)）同步轮次，替代测试中的 `std::thread::sleep` 轮询；四处纯原子并发内核（`SliceWakeGate`、`AcpTurnMachine`、`SessionGenerationTable`、`TeardownGate`）在独立子模块通过 `cargo xtask loom` 穷举线程交错，不侵入业务模块。
- **死代码零容忍，回归测试受保护**：`vp run deadcode` 拦截未使用导出与依赖。修改或删除 `regression: ` 测试，或 `fix/` 分支未补回归测试，须在 PR 正文 `## Regression` 说明（`scripts/release/regression.ts` 检查）。
- **两败验前提、复盘结构化优先漏斗与实证审查**：执行会话在同一门禁基于同一前提连败 2 次须停手证伪前提本身，并遵守先减后加与按可验证单元排序提交（注入于 `crates/server/assets/orchestrator/prompts.json`）；复盘教训凡能写成类型/`xtask`/lint/测试的一律建单补静态防线，禁止堆砌进 `AGENTS.md`；高危评审与性能优化按 [interrogate](.agents/skills/vv-governance/references/interrogate.md)（仅保留附真实失败命令的缺陷）、[blast-radius](.agents/skills/vv-governance/references/blast-radius.md)（证明唯一安全支点事实）与 [benchmark-checklist](.agents/skills/vv-governance/references/benchmark-checklist.md)（必答 `Why not double?`、A/B 交替 ≥5 次中位数与 7 句性能口诀）执行。
- **确定性传感器驱动巡检闭环（`vv-patrol`）**：无人值守巡检与单模块爬山严格遵循「串行传感器选靶（`vp run patrol -- scan`）→ 单假设最小改动 → `make verify-fast` → Keep（单独 commit + 收紧棘轮）/ 全量 Revert → 原生 `Base` 多维台账与树外 TSV 记账 → 诚实退出谓词（达 `kept` 上限或连续 3 轮平台期停机）」，详见 [vv-patrol](.agents/skills/vv-patrol/SKILL.md)。
- **命名一致**：展示名用 `VibeValley`；代码、目录、环境变量 `VIBEVALLEY_*` 和分支前缀 `vibevalley/` 统一用小写 `vibevalley`。

## 怎么走

**执行非平凡改动**

1. 在 VibeValley Issue 看板明确范围、`Category`、`Domain Tags`、`criteria`（架构类补齐 `Alternatives considered`）。
2. 实现代码与测试，通过 `vp check`、`cargo xtask check` 与对应验收检查。
3. 将长期成立的模型、不变量与放弃的路沉淀进 `docs/subsystems/*.md`，更新或关闭对应 Issue。
4. 运行 `vp run docs:verify`。

**防住一类重复问题（按优先级选最高层）**

1. **代码结构与类型**：通过模块边界与类型让错误写法无法编译。
2. **静态检查**：写成 oxlint 规则、`xtask` 审计规则、结构测试或 `docs:verify` 脚本。
3. **文字与 Skill**：无法静态检查的准则写进 `AGENTS.md` 或 `.agents/skills/`。
4. **人工审查**：仅关注产品方向与架构取舍。

**同步 Papertrails 素材**

1. 在同级仓库 `vibevalley-assets` 中修改或生成原始素材（3D 纸雕、品牌图标、角色肖像、引擎徽标与官网配图）。
2. 运行 `design/sync-assets.sh --all`（或按需加 `--with-avatars` / `--with-diorama`）打包并仅同步轻量成品到 `assets/` 与 `apps/mac/resources/`。

## 和谁打交道

- **根目录 `AGENTS.md` 与 `docs/`**：由 `docs:verify` 校验链接、路径、用语表和生成文档同步。
- **CI 与 Git Hooks**：提交前跑 `vp check --fix --deny-warnings`；CI 的 `check` job 跑 `vp check`、`docs:verify`、`scripts:test`、`deadcode` 和 `scripts/release/regression.ts`；Rust 工作区和原生页面由合并前本机的 `make verify` 检查，CI 不再起 macOS 机器。
- **验收 Skill**：`.agents/skills/vv-acceptance/` 提供隔离服务端沙箱（`scripts/release/verify-server.ts`）与实机验证分册。

## 为什么这样

- **优先用代码和检查拦错，报错自带 `Fix:` 与 `See`**：让 agent 看到报错即可一次改对，避免猜解法或绕过规则。
- **以 Issue + 子系统文档取代仓内大量过程文档**：把路线、待办与过程约束留在 Issue 看板，代码仓内只留当前架构现状（`docs/subsystems/*.md`）与常驻准则（`AGENTS.md`），消除旧 Note 与代码长期失步的维护负担。
- **拒绝外部重复工具链与机械行数门槛**：不引入 `ast-grep`、`jscpd`、`dependency-cruiser` 及机械行数/`3:1` 门槛，既避免多套配置漂移，也防止 agent 机械切文件凑数；全部跨层导航与 QA 能力收拢进零新依赖 `cargo xtask`。
- **共用原语自动生成清单（`primitives.md`）**：从 TS 地基目录导出与首行 JSDoc 生成并由 `docs:verify` 守住，让 agent 先复用已有原语；Rust 的不在里面。
- **原素材与轻量成品分仓**：原始高清图、生成脚本与中间产物全部留在独立仓库 `vibevalley-assets`，代码仓只经 `design/sync-assets.sh` / `design/diorama.sh` 同步轻量成品，保持主仓干净。
- **不照搬的外部工程机制**：不引入多 CLI 套壳分发层（坚持 Rust `crates/oar/src` 单底座）、不引入英文标点一刀切禁令（中文写作以 [writing.md](docs/style/writing.md) 为唯一准绳）、不引入多 PR 堆叠链（保持单 PR 内按可验证单元拆有序 commits 再 squash 合入 `main`）。

## 还没做的（按条件触发的白皮书治理项）

| 治理项 | 做法与收益 | 触发时机 |
|---|---|---|
| 扩展点高阶骨架 | 将超时、重试和清理收进高阶函数或 trait，适配器只写纯数据映射 | 随 `#52` 演进 `agent/tool/`；连接器 adapter 超时在出现故障时收拢 |
| 流分片与状态机属性测试 | 按任意字节切片压测流解析器，用 `proptest` 断言核心状态全局不变量 | 出现首个流分片解析回归或核心状态非法组合回归时 |
| 常驻集合上限清点 | 清点服务端常驻 `HashMap` / `HashSet` 的淘汰策略并评估检查规则 | 服务端出现首个内存随运行时间持续增长问题时 |
| `refactor/` 禁改契约与按接口重生成 | 重构分支禁止修改 `crates/protocol/src/contract/`，热点模块按只读契约与测试重写 | 协议契约进入稳定期且模块测试收敛至服务接口后（高频返工热点触发） |
| 契约 diff 与审查压缩比进 CI 摘要 | CI 摘要前置列出契约、实体/迁移与服务接口 diff 及改动比 | 用户开始仅读契约 diff 合入 PR 时 |
| 合并队列（Merge Queue） | 在与最新 `main` 组合后的提交上重跑全量检查（不做符号锁） | 并行 agent 多到 PR 常在合并后互相打破 `main` 时（由用户开仓库设置） |
| 静态防线自愈率 | 从 `session/journal.rs` 轨迹统计 agent 看检查报错一次改对的比例 | 轨迹能稳定区分「检查报错」与「下一次改动」时 |
| PR 评审打分与合并门槛 | 另启模型按清单审 PR 并打分，低于门槛拦截（`comment-review.ts` 仅报不挡） | 有明确评审门槛需要接入 CI 时 |

## 怎么验证

- `vp run docs:verify`：依次执行文档链接、skill、用语表、旧名字与生成物同步检查。
- `cargo xtask audit`：校验服务端扁平无环 DAG、`gateway/` 隔离、`{db,service}/` 数据边界（15 条 `arch-audit` 规则）与并发棘轮。
- `cargo xtask trace|map|deps|ssot-check` 与 `cargo xtask crap|dry|mutate|uml`：跨层追踪、门面复杂度、依赖环、SSOT 巡检与四件套质量度量。
- `cargo xtask loom`：对四个隔离的原子并发内核执行穷举交错模型检验。
- `vp run deadcode`：死代码扫描。
- `vp run scripts:test`：验证 lint 报错格式、沙箱、注释审查与回归门禁。
