---
name: vv-governance
description: 在 VibeValley 里管住 agent 写的代码不变坏：加规矩、lint、检查或棘轮时选最便宜的手段；评审一块代码有没有在变坏（抄第二份、旧的没删、as/空 catch/改断言、N+1、乱引依赖）；执行对抗证伪审查（interrogate）、爆炸半径支点验证（blast-radius）、性能优化七问（benchmark-checklist）与复盘结构化优先漏斗（reflect）；写计划前问清边界；做纯重构或跨很多文件的机械改动；用户问白皮书（五层金字塔、十条铁律）或说「怎么防止 agent 把代码写烂」「这个检查该怎么加」「这块是不是越改越乱」时也用。
---

# 管住 agent 写的代码不变坏

白皮书的判断：代码由 agent 写以后，写代码不再稀缺，稀缺的是架构的一致、契约的完备和用户的注意力；挡问题要按成本从低到高，能用编译器和检查挡的不花模型和人。这和根目录 [AGENTS.md](AGENTS.md#怎么让-agent-做对) 的四层手段是同一个原则，本 skill 把白皮书与工程治理机制对到这个仓库上。

**规矩的家不在这里。** 规矩在 `AGENTS.md`、`docs/` 和各包的 README，和白皮书说法不同时照它们。白皮书是为一个通用的、多人的仓库写的（`src/contracts`、`src/features`、`bun`、外部 AST 规则、300 行上限），不少条和这里的规矩相反（禁用 `default`、契约目录只读、存档快照升级）；照原样做会把仓库往别的方向拉。所以先查一条要点在这里的处境，再动手。

## 先读哪里

- 要回答「白皮书的某一条在这里怎么样」，或者下面任何一步碰到具体的一条：读 [references/whitepaper.md](.agents/skills/vv-governance/references/whitepaper.md) 里对应的一行。每条写了处境：**已有**（在哪）、**已做**（吸收白皮书时加的，在哪）、**改写**（思路留下、换成这里的做法）、**以后做**（什么条件下做，见[工程流程](docs/subsystems/process.md#还没做的按条件触发的白皮书治理项)）、**不做**（为什么）。
- 回答这类问题时，先给处境的结论，再给在哪、为什么；以后做的说出触发条件；不做的说出它和哪条规矩冲突。不要把白皮书的原文当成这里的做法讲。
- 按审查与验证场景加载对应分册（只读用得上的那份）：
  - 涉及 Rust 异步、Tokio 运行时边界、`Hub::on_async`、Axum/SSE/Range、虚拟时钟、`loom` 状态机或 `crates/rich` 后台渲染：读 [references/rust-concurrency-checklist.md](.agents/skills/vv-governance/references/rust-concurrency-checklist.md)。
  - 涉及 `apps/mac/ui`、`apps/mac/src/hosted`、`apps/mac/src/shell` 或 `apps/mobile/src` 的输入延迟、`computed()` 扇出、`keymap.bind`、乐观发送/回滚或宿主帧去重：读 [references/ui-responsiveness-checklist.md](.agents/skills/vv-governance/references/ui-responsiveness-checklist.md)。
  - 需要用隔离 worktree + 异构模型做可运行证伪的对抗式审查（仅保留附真实失败命令的缺陷）：读 [references/interrogate.md](.agents/skills/vv-governance/references/interrogate.md)。
  - 评审跨 `crates/protocol`、`service/`、数据库迁移或 Rust ↔ TS 桥的小而险改动（证明唯一安全支点事实 + 5 级确定性阶梯）：读 [references/blast-radius.md](.agents/skills/vv-governance/references/blast-radius.md)。
  - 评审或执行性能优化（必答 `Why not double?`、A/B 交替 ≥5 次中位数、阿姆达尔上限与 7 句性能口诀）：读 [references/benchmark-checklist.md](.agents/skills/vv-governance/references/benchmark-checklist.md)。

## 1. 加一条规矩或一个检查

agent 照着已有的代码抄、走最短的路，写在文字里的规矩会被漏读、读偏；写成检查的，问题在落地前就被拦下，还不花 token。

1. 说清它挡的是哪一类问题，对上六种病里的哪一种（[六种病](.agents/skills/vv-governance/references/whitepaper.md#六种病)）。说不出一类、只是一次的事，不立规矩：规矩越多越容易漏读。
2. 按顺序选手段，能用前面的就不用后面的：代码（类型、结构、边界，把这一类整个消掉）→ 检查（lint、测试、CI、棘轮）→ 文字（规矩、skill）→ 人看。
3. 写成检查时，失败的话写三样：错在哪和为什么、`Fix:` 能照抄的改法、`See` 仓库里一个文件（[写法](docs/style/code.md#检查管着的写法)）。agent 读到的只有这句话，只说「不许」它就猜，猜的常常是绕过去。lint 规则用 `scripts/audit/oxlint-plugin.ts` 的 `says`，`no-restricted-imports` 的话写进 `vite.config.ts` 的 `refused`；规则算得出改法的就算出来（`parent-import` 给出 `#/…`），能机械改对的给自动修复。
4. 只许减不许增、数得清、又没有动机去刷的，做成棘轮；会被刷的读数（行数、测试数、覆盖率）只出报告，不做门槛，否则 agent 学会的是凑数。
5. 给检查写测试：一个该拦的、一个不该拦的，加上报错的格式。
6. 写不成检查的才进文字：一句规矩放进 `AGENTS.md` 并链到它的家，理由写进对应子系统的「为什么这样」。

## 2. 评审一块代码有没有在变坏

六种病都是 agent 的工作方式带来的，单个 PR 里不显眼，攒起来才坏事。逐条问，每条都有现成的办法查：

| 病 | 问 | 怎么查 |
|---|---|---|
| 局部缝合 | 同一段逻辑是不是抄了第二份？加一个渠道、工具、runtime 时，有没有把超时、重试、清理又写一遍？ | `cargo xtask ssot-check --dupes --json` 与 `cargo xtask dry`；看扩展点（`crates/server/src/agent/tool/` 的各工具、`crates/runtime/src/oar` 的各农机、`crates/server/src/note/media/` 的各种类）有没有自己的超时、`sleep`、重试循环 |
| 只加不删 | 换了新写法，旧的删了没有？ | `vp run deadcode`；搜旧函数名；内部不留兼容：不留旧路、不写兜底 |
| 绕开约束 | 有没有 `as`、`as unknown as`、`!`、关 lint 的注释、空的 `catch`、`.catch(() => undefined)`？测试的断言是不是改松了？ | lint（`no-explicit-any`、`no-unsafe-type-assertion`、`reportUnusedDisableDirectives`）和 clippy；diff 里的测试改动；`regression: ` 开头的测试被动了要在 `## Regression` 里点名 |
| 温室假设 | 循环里有没有逐个查库、逐个起 git？流是不是假设一次到一整行？写盘是不是每来一点就写一次？ | 读循环体；`docs/subsystems/foundation.md`「贵的东西归拥有它的模块管」；测试里有没有大一点的数据 |
| 架构漂移 | 有没有新加依赖？有没有跨层、跨模块、穿过别人 `index.ts` 的 import？ | `pnpm-workspace.yaml` 的 catalog 的 diff；`cargo xtask audit`、`vp check`（`ui-layer-boundaries`、`import/no-cycle`、`no-restricted-imports`）；Rust 的 `Cargo.toml` 依赖的 diff、`mod`/`use` 有没有绕过模块对外的结构体 |
| 看不过来 | 用户要读哪几行才能放心合？契约（`packages/protocol`、表结构、模块对外的接口）改了什么？ | 把契约的 diff 单独列在 PR 正文最前；一批工作一个 PR，不同的事分成不同的提交（[vv-pr](.agents/skills/vv-pr/SKILL.md) 第 1 节） |

查到的照 [vv-simplify](.agents/skills/vv-simplify/SKILL.md) 的格式列给用户：每处带证据（文件和行号、命令的输出）、怎么改、靠哪个测试证明没变坏。只列不改，用户点了再改。涉及 Rust 并发边界、UI 响应性、高危跨层改动或性能优化时，同时对照「先读哪里」列出的专项分册逐项核查。

## 3. 写计划前问清边界

带着猜测写下去的代码，猜错了要整块返工；问一句只花用户几秒。建规划 Issue 或开工前，下面四类有一类说不清，就问用户，不猜：

- **失败和边界**：外面的接口超时或失败时，是忽略、重试几次，还是停下回滚？
- **并发和重复**：同一张工单、同一个人重复触发时，是排队、丢掉新的，还是取消旧的？
- **规模**：列表会不会超过一百条？要不要分页或上限？
- **存量数据**：这一类不用问，答案固定是不兼容：表结构直接改，旧库挪开（[地基](docs/subsystems/foundation.md)）；只有对外 HTTP 的 v1 例外。

问的时候用选择题，一题一个决定，推荐项放第一个并说为什么。

## 4. 做一张纯重构的单

agent 加功能时只在局部补，不会顺手提炼；提炼要单独一道工序，而且这道工序不改行为，用户才能只看「行为没变」的证据就合。

1. 靶子来自读数，不来自印象：`vp run patrol -- scan`、`vp run deadcode`、`cargo xtask diagnose --json`、[vv-simplify](.agents/skills/vv-simplify/SKILL.md) 找到的重复。凭印象挑的常常不是最该清的。
2. 先减后加（Subtract Before You Add）：改动前先删死代码与单调用方包装层；分开不变的和变的，几处一样的控制流（截断、退避、重试、失败时发什么）收进拥有它的模块的服务或骨架函数，同一波迁移调用方并删旧内部接口。
3. 按可验证单元排序提交（Sequence Verifiable Units）：提交顺序保持「先失败复现测试（`regression:`）或先纯删除 → 再最小修复 / 重构」；重构自成一个或几个提交，不和功能的改动混在同一个提交里；单独做的重构分支用 `refactor/`，和同一批的功能一起交时放在同一个 PR，用户要求才拆（[vv-pr](.agents/skills/vv-pr/SKILL.md) 第 1 节）。行为不变：测试只因改名、挪地方而变，断言不减；`regression: ` 开头的测试不动。
4. 结果要可量：删了多少行、调用方少知道了什么、哪个测试证明行为没变，写进那个提交的说明和 PR 的 `## What changed`。行数不设门槛（会被刷），但一张重构单没有让代码变少或变简单，就不该合。

## 5. 一次改很多文件

逐个文件手改，改到后面容易漏、容易改歪；同一种改动交给确定的工具一次做完。

- 改名用 TypeScript 语言服务或 `rust-analyzer`（编辑器的重命名）；去掉没人用的 `export` 用 `vpx knip --fix --fix-type exports,types`；跨文件模式清点先用 `cargo xtask trace` / `cargo xtask ssot-check --dupes --json`，需要批量改写时用一次性临时脚本放在 `/tmp`，不进仓库（进了仓库会被当成代码检查、格式化）。
- 先在一个文件上跑，看 diff 对了再全量跑；全量跑完立刻 `vp check` / `make rust-fast`。脚本出过错的，把它碰过的文件从 `origin/main` 恢复，重新来，不在坏的结果上修补：坏在哪不一定看得出。
- 每处不一样、要逐处判断的（删死代码、改调用方的逻辑），即使文件多也逐处看过再改。
- 漏改由 `vp check`（类型）、`cargo xtask audit` 和 `scripts/docs/stale-names.ts` 兜底：改名是一个决定时，把旧名写进 `stale-names.ts`，旧名就回不来。

## 6. 复盘沉淀（Reflect 结构化优先漏斗与两败验前提）

复盘执行会话轨迹、事故或评审返工时，严格按结构化优先漏斗沉淀教训，严禁把本可机检的细则堆进 `AGENTS.md`：

1. **先判能否写成静态防线**：凡能靠 Rust 类型、Clippy 禁令（`clippy.toml`）、`cargo xtask audit` / `xtask/src/ratchets.rs`、oxlint 规则（`scripts/audit/oxlint-plugin.ts`）、`docs:verify` 脚本或离线 `regression:` 单测拦住的问题，一律在 VibeValley Issue 看板建单（`Category: process | testing`）或当场补门禁，**不**往 `AGENTS.md` 加文字条文。
2. **仅无法机检的判断进 Skill 或子系统文档**：需要人或 agent 权衡的流程沉淀进 `.agents/skills/`，长期架构取舍写进对应 `docs/subsystems/*.md` 的「为什么这样」；根目录 `AGENTS.md` 只留一句话索引并链回它的家。
3. **两败即证伪前提（Attack the Premise）**：排查任何构建/测试/验收失败时，在同一门禁上基于同一前提连续失败 **2 次** 即强制停手，把前提写成明确的一句话，先运行最小观测或测试直接证伪该前提本身，禁止继续打第 3 个盲猜补丁。
