# Agent Note: 代码库跨层导航与单一真源静态巡检工具集

Status: proposed

## Problem

当前仓库在跨层检索、单一真源（SSOT）防漂移与模块结构可观测性上有四个缺口：

1. **跨层追踪成本高**：一次业务能力变更横跨 6 层——`crates/protocol/src/contract/`、`packages/protocol/src/{shapes.gen.ts,endpoints.gen.ts,schema.ts,api.ts}`、`crates/server/src/router.rs` 与领域模块、`crates/server/src/gateway/`、`crates/cli/src/` 以及 `apps/mac/ui/`、`apps/mobile/`。定位一条端点、类型或切片字段的完整链路仍依赖人工逐层搜索。
2. **Rust 与 TS 之间的 SSOT 盲区**：现有 `cargo xtask arch-audit` 只覆盖服务端架构规则，缺少面向跨端对齐的三类静态检查——`ts-enum-mirror`（TS 侧手写枚举或联合类型镜像 Rust 契约）、`host-dto-bypass`（宿主或前端绕过 `@vibevalley/protocol` 的 Zod 解码器直接 `as` 断言或另写 DTO）与 `env-registry-drift`（`VIBEVALLEY_*` 环境变量及默认端口/目录在 Rust 与 TS/脚本间漂移）。
3. **缺少模块门面与依赖环视图**：`xtask/src/arch_metrics.rs` 已计算扇入/扇出，但缺少直接列出任意模块 `mod.rs` 对外门面、`pub` 与 `pub(crate)` 暴露面的工具，也缺少通用的跨模块/跨 crate 依赖图与环路检测命令。
4. **缺少零依赖结构克隆探测**：跨文件重复的辅助逻辑与结构化拷贝缺少轻量级探测入口，难以及时收敛进共享模块。

## Proposal

在保持 `xtask/Cargo.toml` 零新增第三方 crate 依赖（仅保留 `serde` 与 `serde_json`）的前提下，在 `cargo xtask` 中新增 4 项原生命令与统一诊断契约：

### 1. 四项零依赖 `xtask` 能力

| 命令 | 职责 | 关键参数 |
|---|---|---|
| `cargo xtask trace <query>` | 从 `crates/protocol/src/contract/` 到 `packages/protocol/`、`crates/server/src/{router.rs,<domain>,gateway}/`、`crates/cli/src/` 与 `apps/{mac/ui,mobile}/` 的 6 层跨栈链路追踪 | `--json`、`--layer <name>` |
| `cargo xtask map [target]` | 扫描指定 crate 或模块的 `mod.rs` 门面与对外符号，统计并列出 `pub`、`pub(crate)` 与模块文件/行数概览 | `--surface`、`--json` |
| `cargo xtask deps [target]` | 构建模块与 workspace crate 依赖有向图，输出扇入/扇出与强连通/环路检测结果 | `--cycles`、`--dot`、`--json` |
| `cargo xtask ssot-check` | 检查 `ts-enum-mirror`、`host-dto-bypass`、`env-registry-drift` 三类跨端漂移，并支持归一化 token 窗口结构克隆探测 | `--dupes`、`--rule <id>`、`--json` |

### 2. 统一处方式 `--json` 输出格式

所有诊断条目统一输出扁平结构，便于 agent 与脚本直接定位并修复：

```json
{
  "rule": "ts-enum-mirror",
  "file": "apps/mac/ui/workspace/chatSession.ts",
  "line": 102,
  "symbol": "FALLBACK_RUNTIMES",
  "why": "hand-written runtime enum/list duplicates Rust contract",
  "fix_hint": "import generated enum/types from @vibevalley/protocol"
}
```

### 3. 代码组织约定与 3-Worker 并行拆分

- **收敛门面与可见性**：模块 `mod.rs` 应只重导出对外窄接口；内部辅助结构体与函数默认保持私有或 `pub(crate)`，用 `cargo xtask map` 与 `cargo xtask deps --cycles` 持续审视暴露面。
- **阶段一零冲突脚手架**：由 `nav-integrator` 在 `xtask/src/main.rs` 预先接好 `trace`、`map`、`deps`、`ssot` 模块声明、子命令分发与 `print_usage()`，后续 3 个并行 worker 互不修改 `xtask/src/main.rs`：
  - `nav-trace`：负责 `xtask/src/trace.rs`
  - `nav-map-deps`：负责 `xtask/src/map.rs` 与 `xtask/src/deps.rs`
  - `nav-ssot-radar`：负责 `xtask/src/ssot.rs`（含 `--dupes` 结构克隆探测）

### 4. 首轮实测基线（`feat/codebase-nav-and-ssot-tools` 合流后）

| 命令 | 实测基线结果 |
|---|---|
| `cargo xtask trace orphans --json` | 索引 197 项协议端点：`zero_caller_orphans=31`、`single_client_gaps=91`、`multi_client_covered=75` |
| `cargo xtask map crates/server --surface` | 扫描 184 个文件、27 个模块、57,555 非测试 LOC、2,174 `pub`、270 `pub(crate)`、87 重导出；识别 15 个宽门面热点与 15 个高复杂度函数（区分深层嵌套条件与扁平 `match` 分发） |
| `cargo xtask deps server --cycles --ui` | 服务端 25 个模块、116 条依赖边、0 个强连通环（0 cycles）、3 条底层反向引用（`crates/server/src/config.rs` 指向 `connector`/`issue`/`voice`）；扫描 292 个 UI 文件，检出 21 处跨 feature 深层导入（`ui-cross-feature-deep-import`） |
| `cargo xtask ssot-check --dupes --json` | 扫描 1,314 个文件，共 318 条发现：`ts-enum-mirror=28`、`host-dto-bypass=18`、`env-registry-drift=44`、`structural-clone-radar=228`（`--min-lines 25`、相似度 `>= 0.80`） |

### 5. 工具链演进路线图（Uncle Bob 静态指标启发）

- **`dryer` 启发式结构克隆雷达（首版已落地）**：`cargo xtask ssot-check --dupes` 对非测试 `crates/server/src` 与 `apps/{mac/ui,mobile}` 做标识符归一化 token 窗口指纹比对（`--min-lines 25`、相似度 `>= 0.80`），已建立 228 处克隆基线，后续可按热点逐步收拢共享辅助函数。
- **`crapper` 启发式函数复杂度与 diff-CRAP 棘轮（阶段二路线图）**：`cargo xtask map --surface` 已落地按嵌套条件权重计分的函数复杂度榜单（区分扁平 `enum match` 分发与深层分支嵌套）；下一里程碑接入 `cargo llvm-cov --json` 增量行覆盖率，计算变更函数的 CRAP 分数并作为 diff-CRAP 门禁。
- **`mutator` 启发式变异测试试点（阶段二路线图）**：下一里程碑在快速纯计算模块（仅限定于 `crates/core` 与 `crates/git/src/read.rs`）试点 `cargo-mutants --in-diff`，度量关键领域规则与纯 Rust Git 读取路径的测试杀伤率，不扩散至重编译服务端二进制。

## Alternatives considered

- **引入独立 `syn` AST 解析器 vs 复用轻量 `xtask/src/rust_scan.rs` 与 `std::fs`**：引入 `syn`/`quote`/`proc-macro2` 会扩大 `xtask/Cargo.toml` 依赖树、拉长首次编译与 `Cargo.lock` 体积，且仍无法覆盖 TS 与跨端边界；复用已有的 [xtask/src/rust_scan.rs](xtask/src/rust_scan.rs)（已实现注释、字面量与 `#[cfg(test)]` 剥离及精确 1-based 行号保留）配合 `std::fs` 与 `serde_json` 可保持零新依赖与毫秒级扫描速度。
- **引入外部 CI 工具（`ast-grep`、`cargo-machete`、`jscpd`）vs 零依赖 `xtask` 核心加可选离线巡检脚本**：外部二进制工具需要额外的本地与 CI 安装维护，输出格式分散；把核心导航与 SSOT 校验做进 `cargo xtask` 可保证本地与 CI 零配置可用并统一输出格式，若未来需要更深的 TS AST 规则，再按需补充离线脚本。

## Acceptance criteria

- `xtask/Cargo.toml` 保持零新增依赖（仅 `serde` 与 `serde_json`）。
- `xtask/src/main.rs` 接入 `trace`、`map`、`deps`、`ssot-check` 四个子命令，均支持 `--help`/`-h` 与 `--json`，且 `cargo fmt --all -- --check`、`cargo clippy -p xtask --all-targets -- -D warnings`、`cargo test -p xtask` 全部通过。
- `trace` 可串联 6 层链路，`map` 可识别 `pub`/`pub(crate)` 暴露面，`deps` 可检测模块依赖环，`ssot-check` 覆盖 `ts-enum-mirror`、`host-dto-bypass`、`env-registry-drift` 与 `--dupes` 且均有正反例单元测试。
- `vp run notes:verify` 与 `vp run docs:verify` 全部通过。

## Risks

- **误报控制**：词法与模式扫描在命中 `*.gen.ts`、测试夹具或合法边界适配代码时可能产生误报；应在扫描规则中明确排除生成物与测试路径，并为每条规则编写豁免单测。
- **`pub` 启发式边界情况**：不经过完整宏展开时，跨行签名、条件编译 `#[cfg(...)]` 与宏生成的 `pub` 项可能影响 `map` 的可见性统计；应通过词法括号匹配与单测覆盖常见可见性写法（`pub`、`pub(crate)`、`pub(super)`），并在输出中注明静态扫描边界。
- **与 `origin/main` 并行演进对齐**：Track A（`refactor/ssot-git-tokio-convergence`）同时收敛网关、协议与仓库模块，阶段三合流时需基于最新 `origin/main` 验证 4 个子命令在真实代码库上的输出与测试基线。
