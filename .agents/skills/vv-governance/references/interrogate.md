# 对抗式证伪审查（Interrogate）

在合并高风险分支、长程自治产出或 `in_review` 工单之前，用隔离 worktree + 异构模型做可运行证伪的对抗式审查。唯一硬规矩：**只有附带真实运行命令与实际失败输出的缺陷才准保留；纯代码阅读臆测一律归入 `Dropped`，绝不混进评审噪音。**

## 什么时候用

- 合并跨 `crates/protocol`、`crates/server/src/{service,router,gateway}`、`apps/mac/src` 或并发状态机的关键分支前。
- 无人值守巡检（[vv-patrol](.agents/skills/vv-patrol/SKILL.md)）或长程执行会话交回前，核对是否存在「无证据报喜」或「掩盖症状的补丁」。
- 用户要求「对抗审查」「打一轮 interrogate」「挑毛病并复现」。

## 步骤

1. **建立只读隔离 worktree**：从待审分支切出临时只读 worktree，禁止在主工作区或作者分支上直接改代码。
2. **分派异构模型攻击**：优先选用与作者不同的模型家族作为只读审查者，给它分支 diff 与子系统文档（`docs/subsystems/*.md`），要求只盯可证伪的失效路径（并发竞态、边界解码错误、状态撕裂、事务遗漏、回滚漏清理、序列化不兼容）。
3. **强制运行证伪**：每条候选缺陷必须通过真实命令（`cargo nextest run`、定向单元测试、协议解码脚本或 `vp run vdp`）打出实际失败或错误状态输出；跑不出失败的臆测统一标 `Dropped` 并附理由，不得升级为阻塞意见。
4. **写入结构化台账与首屏警示**：
   - 有 VibeValley 服务端时，将每条经验证的缺陷经 `vv_base_upsert_row` 写入关联 `NoteType::Base` 分诊表（列：`target`、`verdict` 为 `confirmed | dropped`、`repro_cmd`、`observed_output`、`issue_ref`），并在工单正文首屏用 `callout`（`tone: "bad"` 或 `"warn"`，标题 `Attention`）置顶已证伪的高危缺陷，完整失败输出收进 `toggle`（`collapsed: true`）。
   - 无服务端时，按同样字段输出精简表格，先列 `Confirmed`（按严重度降序），再折叠或简列 `Dropped` 数量。
5. **收拾隔离 worktree**：审查结束后移除临时 worktree，只保留台账记录与工单意见，不残留临时分支。

## 准入标准（门禁）

| 类别 | 必需证据 | 处理方式 |
|---|---|---|
| `Confirmed` | 精确文件路径、可复制复现命令、真实失败/异常输出 | 写入 `Base` 分诊表并作为阻断项打回作者修复（先补 `regression:` 测试） |
| `Dropped` | 未能复现、已有不变量/门禁覆盖或属 `docs/subsystems/*.md` 既有取舍 | 仅留计数与一句归因，不发给作者当待修项 |
