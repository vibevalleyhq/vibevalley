# Agent Note: 基于纯 Rust 零新依赖 xtask 严格对齐 Uncle Bob 规格的质量门禁套件（crap / dry / mutate / uml）

Status: proposed

## Problem

为了在 VibeValley（Rust + TypeScript/TSX）本地与 CI 中提供严格对齐 `@unclebob/{ub-mode,crapper,dryer,mutator,uml-viewer}` 规格的质量门禁，上一版构想存在两类需要收敛的问题：

1. **四件套契约与交互模型容易被低估**：Uncle Bob 的 `ub-mode`、`crapper`、`dryer`、`mutator`、`uml-viewer` 并非孤立 CLI——它们共享完全一致的 `(namespace, name, visibility)` 主键，并以 `.metrics/`（`crap.json`、`dry.json`、`mutate/<ns>.json`）和 `.uml/`（`policy.json`、`topology.json`）作为叠加快照层；`uml-viewer` 也是支持层级下钻、5 档 Declutter、Class Card、Dependency Rule 违例标红与 What-If 提案的交互式视图，不能只用静态 SVG 替代。
2. **工具链重量与宿主耦合约束**：`xtask` 目前仅依赖 `serde` + `serde_json`（极速编译），不能引入 `syn`、`oxc_parser`、Web 框架或其它外部 crate；同时桌面应用 `apps/mac` 不应为离线工程质量工具耦合新视图，交互式 UML 查看器应作为独立本地 Web 服务运行。

## Proposal

在不增加任何新 crate 依赖的前提下（`xtask/Cargo.toml` 严格保持 `serde` + `serde_json`），于 `xtask/src/qa/` 实现仅支持 **Rust + TypeScript/TSX**、严格对齐 `@unclebob/{ub-mode,crapper,dryer,mutator,uml-viewer}` 的纯 Rust 质量门禁套件，并在 `xtask/src/main.rs` 暴露 `crap`、`dry`、`mutate`、`uml` 四个子命令。

### 0. 共享核心与跨工具统一身份键（`xtask/src/qa/{mod.rs, lang.rs}`）

所有工具围绕 **Policy（人/Agent 写） / Topology IR（生成） / `.metrics/`（度量叠加）** 三层分离协同，共享统一的 `FormInfo` 与规范快照：

| 维度 | Rust 规则 | TypeScript / TSX 规则 |
|---|---|---|
| **`:namespace`（类/模块主键）** | `crate::module` 或 `crate::module::Type`（跳过 `#[cfg(test)]`、`mod tests` 与嵌套闭包） | 相对包根点分路径（如 `features.artifact.html`）或 `module.Class`（跳过嵌套回调） |
| **`:name` 与私有标记** | 函数/方法名；无 `pub` 标为私有（`Private`） | 函数/方法/顶层箭头函数名；`private` / `#` 标为私有（`Private`） |
| **快照落盘路径** | `.metrics/crap.json`、`.metrics/dry.json`、`.metrics/mutate/<ns>.json`、`.uml/policy.json`、`.uml/topology.json`（JSON 一级格式 + 可选 `to_edn` 导出） | 同左（全部纳入 `.gitignore`，本地运行不污染工作区状态） |

- `xtask/src/qa/mod.rs`：定义公共类型（`Lang`、`Visibility`、`FormInfo`）、`.metrics/` 快照结构体与 JSON/EDN 读写、Rust `cargo llvm-cov --lcov` 与 Vitest `lcov.info` 通用 `parse_lcov`、`--changed` 所需的 `git` 变更文件收集，以及跳过 `target`、`node_modules`、测试目录与生成物（`*.gen.*`）的源码收集器。
- `xtask/src/qa/lang.rs`：纯 `std` 零外部依赖的 Rust + TypeScript/TSX 词法分析器与结构提取器——精确保留每枚 token 的字节偏移与 1-based 行号，准确跳过注释（含 Rust 嵌套块注释）、字符串、Rust 原始字符串（`r#"..."#`）、字符字面量、TS 模板字符串（含 `${...}` 插值）与 TS 正则字面量；同时提供圈复杂度计算、归一化 token 流（`dry`）、模块导入/继承关系提取（`uml`）以及源码行定位 `locate_member`。

### 1. 四件套严格规格实现（仅 Rust + TypeScript/TSX）

1. **`cargo xtask crap`**（圈复杂度 + 覆盖率 -> CRAP，`xtask/src/qa/crap.rs`）：
   - 严格计算 `CRAP = CC² × (1 − coverage)³ + CC`（1–5 低风险、5–30 需关注、30+ 高复杂欠测试），支持 `--no-coverage`、`--use-existing-coverage`、`--changed`、路径过滤与 `--threshold N`（超阈退出码 `2`），并附带平铺穷尽 `match` 诊断标注而不扭曲基准分数。
2. **`cargo xtask dry`**（归一化结构指纹克隆检测，`xtask/src/qa/dry.rs`）：
   - 保留调用名/方法名、运算符与控制结构，归一化局部标识符、字段名（如 `order.total` 与 `row.amount` 同形）与字面量；按 Jaccard 相似度 `shared / union` 计算，默认 `--threshold 0.82`、`--min-lines 4`、`--min-nodes 20`、支持 `--changed` 且严禁跨语言比较。
3. **`cargo xtask mutate`**（函数级内容哈希增量 + 覆盖率门控变异测试，`xtask/src/qa/mutate.rs`）：
   - 按 `(namespace, name)` 在 `.metrics/mutate/<ns>.json` 记录 `body_hash` 与变异结果；默认增量重跑文本变化函数与上次幸存者，未覆盖行标 `uncovered` 并跳过；支持 `--scan`、`--changed`、`--mutate-all`、`--since-last-run`、`--no-coverage`、`--use-existing-coverage`、`--max-workers`。
   - 在 `target/mutation-workers/` 建立隔离覆盖工作区（永不改动活树），先跑基线确定超时 `max(2s, 10 × baseline)`；严格退出码 `0`（全杀）、`2`（基线失败且不覆盖快照）、`3`（存在幸存者）。
4. **`cargo xtask uml`**（Policy / Topology IR / Dependency Rule / 静态导出 + 独立本地 Web 查看器，`xtask/src/qa/{uml.rs, viewer.rs, viewer.html}`）：
   - **拓扑与依赖校验**：严格遵循真实命名空间树（禁止虚构包分层），按 Policy `:levels` 判定 `:dependency` 边 `from_rank < to_rank` 为违例红箭头（`:implements` 与 `:association` 不报违例），缺失 CRAP 或变异数据时按最差 `grade 1` 着色并在右上角展示 `C` / `M` 双色点。
   - **独立本地 Web 查看器（`cargo xtask uml viewer [--port N] [--open]`）**：由 `std::net::TcpListener` 托管内嵌单页 `viewer.html`，提供命名空间下钻/`Esc` 返回、5 档 Declutter（含去连线入/出三角与悬停违例清单）、Class Card（CRAP `μ/max/σ` + Mutation 明细 + `locate_member` 源码高亮跳转）、What-If `:proposals` 沙盘与局部刷新端点；**不改动 `apps/mac`**，GPUI 桌面集成留待后续评估。

## Alternatives considered

### 1. 纯 Rust 零依赖词法/结构扫描器 vs 引入 `syn` + `oxc_parser`
引入 `syn`、`quote`、`proc-macro2` 与 `oxc_parser` 会显著拉长 `xtask` 全量编译时间并扩大传递依赖树，违背 `xtask/Cargo.toml` 仅保留 `serde` + `serde_json` 的零重依赖约束。基于 `xtask/src/rust_scan.rs` 已验证的偏移保真扫描思路自研纯 `std` Rust + TypeScript/TSX 词法与结构提取器，既能精确识别嵌套注释、原始字符串、TS 模板插值、TS 正则、函数边界与 `FormInfo` 字节跨度，又让 `cargo xtask` 编译保持在秒级。

### 2. `std::net::TcpListener` 独立本地 Web 查看器 vs 直接写进 `apps/mac`（GPUI + nsh）
把 UML 查看器直接嵌进桌面客户端会把离线工程分析工具和主产品 UI 生命周期绑在一起，还会增加 GPUI/TSX 改动面。用 `std::net::TcpListener` + 单文件内嵌 `viewer.html` 提供 `cargo xtask uml viewer [--port N] [--open]`，既能完整交付下钻、Declutter、Class Card 与源码行预览等全部交互，又保持 `apps/mac` 零改动；若未来需要桌面入口，可作为独立阶段再接入。

### 3. 直接引入 Uncle Bob 原仓库（Python + Clojure/JVM/Quil）
原仓库各自维护 Python `.venv` 与 JVM/Clojure 桌面栈，无法共享 VibeValley 本仓 `xtask` 构建与离线扫描设施，也难以针对 Rust `#[cfg(test)]` / `mod tests` 与 `nsh` TSX 做定制。

## Acceptance criteria

1. **零新依赖与边界隔离**：`xtask/Cargo.toml` 仅含 `serde` 和 `serde_json`；`apps/mac/**` 零改动；`.metrics/` 与 `.uml/` 已加入 `.gitignore`。
2. **统一主键与快照协议**：`crap`、`dry`、`mutate`、`uml` 共享 `xtask/src/qa/{mod.rs, lang.rs}` 的 `(namespace, name, visibility)` 主键与 `.metrics/` / `.uml/` JSON 协议，Rust `crates/core` 与 TS `packages/protocol` 上主键一致。
3. **四工具核心行为与单测全绿**：
   - `crap`：精确计算 `CRAP = CC² × (1 − cov)³ + CC`，支持 `--no-coverage`、`--use-existing-coverage`、`--changed` 与 `--threshold` 退出码 `2`。
   - `dry`：同一语言内归一化局部名与字面量后精确检出结构克隆，跳过 `< min_lines` / `< min_nodes`、`#[cfg(test)]` 与嵌套回调，不跨语言误匹配。
   - `mutate`：在 `target/mutation-workers/` 隔离运行，支持 `hash` 增量缓存、`uncovered` 门控与精确 `0`/`2`/`3` 退出码。
   - `uml`：正确判定 Dependency Rule 违例与 `C`/`M` 叠色梯度，`cargo xtask uml viewer` 通过 `std::net::TcpListener` 启动本地交互界面并支持下钻、Declutter、Class Card 与 `locate_member` 源码定位。
4. **`cargo fmt --all -- --check`、`cargo clippy -p xtask --all-targets -- -D warnings`、`cargo test -p xtask` 与 `vp run docs:verify` 全部通过**。

## Risks

- **纯手写扫描器对极端语法边界的处理**：Rust 宏定义体（`macro_rules!`）或复杂的 TS 类型体操/JSX 泛型与正则表达式边界（`/` 除法 vs 正则字面量）容易误判；需要用覆盖面充分的单测（原始字符串、模板插值 `${...}`、JSX 自闭合标签、泛型尖括号、嵌套块注释、`#[cfg(test)]`）把边界钉死。
- **TS 隔离变异工作区的相对导入与 `@vibevalley/*` 别名解析**：`mutate` 的隔离工作区需要正确处理包内相对路径与工作区软链，否则测试可能仍读取原始工作树文件。
- **单二进制内嵌 `viewer.html` 的状态同步**：本地 Web 查看器通过 HTTP API 拉取 `.uml/` 与 `.metrics/` 及触发局部刷新，需要确保并发刷新时文件锁与快照写入原子性，避免读取半截 JSON。
