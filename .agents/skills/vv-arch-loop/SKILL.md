---
name: vv-arch-loop
description: 用静态分析驱动 VibeValley 的大面积架构重构闭环（诊断 → 分诊 → 修复 → 验证 → 棘轮）：先用 `cargo xtask diagnose --json`、`arch-audit`、`ssot-check`、`clippy`、`deadcode` 和 `rust-analyzer` 拿到确凿热点，再把系统性平面和局部单点切开、并行分工、分工具修复，验完立刻收紧 `xtask` 天花板和 `clippy.toml`。用在：要做跨模块重构、拆大文件、清并发债/锁热点/DAG 环、或者用户说「跑架构诊断」「按分析器重构」「收紧棘轮」「arch loop」时。
---

# 分析器驱动的架构重构闭环（5 步）

不要靠肉眼翻目录猜哪里乱。重构的每一步都以确定性分析器的输出为唯一事实源：先量化健康指标与违例清单，再按平面切分无冲突写集，修复后立刻把新水位焊死成棘轮，防止下一个 agent 把旧病写回来。

本 skill 与 [vv-governance](.agents/skills/vv-governance/SKILL.md) 及 [vv-patrol](.agents/skills/vv-patrol/SKILL.md) 配合使用：规矩与六种病的判据看 `vv-governance`，无人值守多轮爬山与台账记账用 `vv-patrol`，具体执行一轮跨模块架构重构闭环照下面 5 步。

## 第 1 步：诊断（Diagnose）

用机器可读的数据建出当轮的精确工作清单，不凭印象选靶子：

```bash
# 1) 一秒拿到模块健康度（LOC / pub_symbols / depth_ratio / Ca / Ce / instability / locks / >800 LOC）、Top-N 热点和处方式违例
cargo xtask diagnose --json

# 2) 按域看锁分布与扁平服务端架构红线
cargo xtask arch-audit --report-locks

# 3) Rust <-> TS SSOT 漂移与跨文件结构克隆（已并入 cargo xtask audit）
cargo xtask ssot-check --dupes --json

# 4) 编译器与语义禁令（含根目录 clippy.toml 的 disallowed-methods / disallowed-types）
cargo clippy --workspace --all-targets -- -D warnings

# 5) TS 侧死代码与未使用导出
vp run deadcode
```

需要精确调用图、trait 实现列表或跨 crate 引用时，用 `cargo xtask trace`、`cargo xtask map --surface` 与 `rust-analyzer`（符号引用/类型解析），不引入外部重复扫描器，也不靠全文字符串盲搜。

## 第 2 步：分诊（Triage）

把诊断结果分成**系统性平面**与**局部单点**，严禁把两类混进同一次修改：

1. **先切平面（Systemic Planes）**：
   - 依赖图环（`server-domain-dag`）与反向穿透（`no-gateway-reverse-import`、`no-sea-orm-outside-service`）
   - 并发与异步原语债（`flume`、`block_on`、裸 OS 线程、`std::fs::`、同步/异步成对重复）
   - 边界解码泄漏（`no-value-in-internal-sig`）与延迟绑定钩子（`no-late-bind-hook`）
   - 平面问题必须在根因层一次打穿（例如先把公共类型下沉到 `context` 或 `service`），否则局部修补只是搬运。
2. **再切单点（Local Points）**：
   - 超长文件（`oversized_files`，> 800 非测试行）
   - 浅封装（低 `depth_ratio` 且导出符号过多）与高耦合模块（高 `fan_in + fan_out`）
   - 单域锁热点（`lock-hotspot`：`Mutex<` / `RwLock<` 聚集）
3. **划定互不重叠的文件归属（Disjoint File Ownership）**：
   - 并行派发多个 worker 时，每个 worker 领取明确的文件列表或独立顶层模块；任何文件同一时刻只归一个 worker 写。
   - 共享契约或公共入口（如 `lib.rs`、`router.rs`、`app.rs`）由整合者统一收口，或单独排在依赖批之后。

## 第 3 步：修复（Fix）

按改动性质选最便宜、最确定的执行器：

- **机械性、模式固定的跨文件改写**：优先用 `rust-analyzer` / TypeScript 语言服务重命名、`vpx knip --fix --fix-type exports,types`，或放在 `/tmp` 的一次性脚本。先在单文件试跑看 diff，再全量应用，不手改几十处同类代码。
- **语义重构与抽象提炼**：交给 LLM worker 逐切片完成：
  - 每次提交只做架构重构（纯结构调整或并发迁移），不夹带功能变更。
  - 优先做深模块（收窄 `pub` 表面、合并透传包装）而非为了压行数把一个逻辑硬切成碎文件。
  - 删旧路不留兼容：旧接口、旧桥接、旧兜底在同一批删干净。

## 第 4 步：验证（Verify）

改完先跑窄检查（迭代用 `make rust-fast`，严禁并发多个 `cargo` 进程），合批前跑齐对应层级的硬门禁：

```bash
# 1) 格式、架构边界与编译器语义门禁
cargo fmt --all --check
cargo xtask audit
cargo clippy --workspace --all-targets -- -D warnings

# 2) 全量单元与集成测试（优先 nextest）
cargo xtask check

# 3) 并发状态机穷尽检查（涉及 runtime/server 锁、取消、mailbox、通道时必跑）
cargo xtask loom

# 4) SQLite + PostgreSQL 双库测试（涉及 db / entity / migration / service 查询时必跑）
cargo test -p vibevalley-server --features postgres
```

凡改动触及 HTTP 接口、服务端行为、原生应用页面或像素场景，必须按 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 起隔离沙箱跑真实程序并留存证据。

## 第 5 步：棘轮（Ratchet）

验证全绿后，**在同一批改动里立刻锁紧门槛**，绝不留待「下个 PR 再加」：

1. 重跑 `cargo xtask diagnose --json` 核对新水位：`diagnostics` 下降、目标热点的 `loc` / `depth_ratio` / `fan_in` / `fan_out` / `lock_count` 改善。
2. 立刻下调 `xtask/src/arch_audit.rs` 与 `xtask/src/ratchets.rs` 中的只降不升天花板常量到最新实测值（例如 `MAC_BLOCK_ON_CEILING`、`SERVER_BLOCK_ON_CEILING` 等，永远只减不增）。
3. 当某一类危险 API 在工作区归零后，立即在根目录 `clippy.toml` 的 `disallowed-methods` / `disallowed-types` 中取消对应注释或新增语义禁令，并跑 `cargo clippy --workspace --all-targets -- -D warnings` 确认 0 违例。
4. 补一条 `xtask` 单元测试或回归测试钉住新不变量，确保同类架构漂移在编译或 `xtask` 阶段即刻失败。
