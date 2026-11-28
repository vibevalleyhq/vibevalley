---
name: vv-patrol
description: 用确定性传感器驱动 VibeValley 的无人值守仓库巡检与单模块爬山闭环（Triage → 单假设最小改动 → make verify-fast → Keep/Revert + 棘轮 → Base/TSV 台账 → 退出谓词）。用在：执行定时或过夜巡检（/goal、/schedule）、对单个热点模块做零行为变更 Hillclimb、用 `vp run patrol` 汇总传感器热点与管理巡检账本，或用户说「跑巡检」「patrol」「hillclimb」「爬山优化」时。
---

# 确定性传感器驱动巡检与爬山闭环（vv-patrol）

开放式「随便逛并优化」会稳定退化为过早交卷或制造 AI Slop（[vv-governance](.agents/skills/vv-governance/SKILL.md) 六种病）。本 skill 把「找靶子」「改代码」「验真」「记账」「停机」固化为确定性闭环：候选靶子只能来自量化传感器或看板既有治理单，每轮严格只检验 **1 个最小假设**，指标实质改善且门禁全绿才单独提交并收紧棘轮，否则全量回滚。

## 传感器与门禁映射

| 巡检维度 | 确定性传感器（选靶） | 门禁与棘轮（验真 + 焊死） |
|---|---|---|
| 死代码 / 边界违例 / 双源漂移 | `vp run deadcode`、`cargo xtask audit`、`cargo xtask ssot-check --dupes --json` | `make verify-fast BASE=origin/main` + [vv-simplify](.agents/skills/vv-simplify/SKILL.md) 判据 |
| 架构热点 / 暴露面 / 锁聚集 | `cargo xtask diagnose --json`、`cargo xtask arch-audit --report-locks`、`cargo xtask map --surface --top 20` | `make rust-fast BASE=origin/main` + 下调 `xtask/src/ratchets.rs` / `xtask/src/arch_audit.rs` 天花板（配合 [vv-arch-loop](.agents/skills/vv-arch-loop/SKILL.md)） |
| 结构克隆 / 高风险漏测 | `cargo xtask dry`、`cargo xtask crap`、`cargo xtask mutate` | 先补失败的离线 `regression:` 测试，再最小修复 |
| 页面布局与交互退化 | `make vdp SCENE=all`（`manifest.json` + 截图） | `vp run mac:check` + `vp run vdp <scene> --ui-only` |

## 闭环步骤

1. **隔离分支并读取账本**：在基于 `origin/main` 的独立分支或 worktree 执行；动手前先查当前账本状态，防止重复试错：

   ```bash
   vp run patrol -- status --ledger /tmp/vv-patrol-decisions.tsv
   ```

2. **确定性传感器选靶（串行执行，禁止并发 `cargo`）**：运行统一巡检扫描获取量化热点（或取看板既有治理单），每次只取收益最高、写集最小的 **1 个假设**；改代码前必须先读对应 `docs/subsystems/*.md` 的「为什么这样」，尊重既有设计取舍：

   ```bash
   vp run patrol -- scan --ledger /tmp/vv-patrol-decisions.tsv
   # 包含克隆与 CRAP 全套传感器：
   vp run patrol -- scan --profile full --json
   ```

3. **单假设最小改动与 `needs-human` 分流**：
   - 遵循「先减后加」「按可验证单元排序提交」与「同前提连败 2 次强制停手证伪前提」（见 [vv-governance](.agents/skills/vv-governance/SKILL.md#6-复盘沉淀reflect-结构化优先漏斗与两败验前提)）。
   - 触及对外 HTTP `v1` 契约、产品行为取舍、不可逆操作，或与 `docs/subsystems/*.md` 既有取舍冲突时，**不擅自修改**，记录 `verdict=needs-human` 跳过并继续下一靶子。
4. **分层门禁验证**：
   - 全仓巡检跑 `make verify-fast BASE=origin/main`；纯 Rust 单模块爬山跑 `make rust-fast BASE=origin/main`；UI 改动加跑 `vp run vdp <scene> --ui-only`；修缺陷必须先写失败的 `regression:` 测试。
   - **警告**：严禁同时并发运行多个 `cargo` 进程，避免目标目录锁竞争与缓存抖动。
5. **Keep / Revert + 棘轮 + 台账落库**：
   - **Keep**：门禁全绿且目标读数或简洁度实质改善 → 单独提交一条英文 commit；若架构/并发水位下降，在同一批下调 `xtask/src/ratchets.rs` / `xtask/src/arch_audit.rs` 天花板。
   - **Revert**：门禁失败或边际收益不足 → 立刻丢弃工作区全部改动（`git checkout -- .` 并清理未跟踪临时文件），绝不残留「也许有用」的修改。
   - **台账记账**：
     - 服务端可用时，优先将本轮结果经 `vv_base_upsert_row` / `note_base_upsert_row` 写入关联 `NoteType::Base` 巡检台账（含 `formula` 净降幅列、`table`/`board` 泳道、`Row=Page` 证据子页与 `agentAction` 派单列），并向关联工单正文经 `vv_doc_append_block` 追加 `kpi`、`baseEmbed`、`callout`、`compare`、`issueCard`、`toggle`（`collapsed: true`）。
     - 同步写入 git 树外 TSV 账本（可加 `--base-row` 同时输出可直接传给 `vv_base_upsert_row` 的 `cells` JSON）：

     ```bash
     vp run patrol -- record \
       --ledger /tmp/vv-patrol-decisions.tsv \
       --category arch \
       --target crates/server/src/router.rs \
       --hypothesis "Drop dead pass-through wrapper" \
       --before 131 --after 124 \
       --gate "make verify-fast" \
       --verdict kept \
       --note "commit abc1234" \
       --base-row
     ```

6. **诚实退出谓词（Exit Predicate）**：达到下列任一条件立即停机，跑一次 `make verify` 后输出账本汇总、commit 清单与 `needs-human` 事项（严禁放宽断言或凑行数宣布胜利）：
   - 累计落地目标个数的 `kept` 原子提交（默认全仓巡检 `8` 个，单模块爬山 `6` 个）；
   - 连续 `3` 轮不同方向尝试均被 `reverted`（进入平台期）。

## 标准提示词模板（供 `/goal` 与 `/schedule` 复用）

### 模板 A：全仓持续巡检闭环（`Triage → Hillclimb`）

```markdown
请在基于 origin/main 的独立分支/worktree 上按 vv-patrol 执行无人值守「传感器选靶 → 单假设修复 → 验证棘轮」闭环：
1. 先用 `vp run patrol -- status` 读 `/tmp/vv-patrol-decisions.tsv`（服务端可用时同步更新 Base 巡检台账），防重复试错。
2. 靶子仅来自 `vp run patrol -- scan`（deadcode / xtask audit / ssot-check / diagnose / dry / crap）或看板既有治理单；动手前必读对应 `docs/subsystems/*.md`（「为什么这样」）。
3. 每轮严格只做 1 个假设：最小改动 → 串行跑 `make verify-fast BASE=origin/main`（UI 加跑 `vp run vdp <scene> --ui-only`；修缺陷先补失败 `regression:` 测试）→ 全绿且实质改善才单独英文 commit 并收紧棘轮，否则全量 revert 并记账。
4. 触及对外 HTTP v1 契约或产品取舍记 `needs-human` 跳过；同前提连败 2 次强制停手证伪前提。
5. 退出条件：累计 8 个 `kept` 原子提交，或连续 3 轮 `reverted`；收尾跑一次 `make verify` 并汇报账本汇总、commit 清单与 `needs-human` 事项。
```

### 模板 B：单模块专项爬山（`Hillclimb`）

```markdown
对 `<模块路径>` 按 vv-patrol 执行零行为变更 Hillclimb：先用 `cargo xtask diagnose --json`、`cargo xtask map <模块> --surface` 与 `cargo xtask crap <模块>` 冻结基线并确认测试全绿；在 `/tmp/hillclimb.tsv` 逐轮用 `vp run patrol -- record --max-kept 6` 记录单一结构假设与前后读数；每轮过 `make rust-fast BASE=origin/main` 且指标改善才 commit 并收紧 `xtask/src/ratchets.rs`，否则全量 revert；满 6 个 `kept` 迭代或连续 3 轮平台期停机汇报。
```
