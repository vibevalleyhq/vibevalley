# Agent Note: 已交付工单的隔离集成验收

Status: proposed

## Problem

main `410d8d15` 已含发布、生命周期与打包修复，尚未包含 #1、#2、#16 的交付。来源报告不能代替组合后的验收；#2 的旧 project/workspace/records 名称必须承接 main 的 repo/space/registry。

## Proposal

本单独立完成，不派子单。先复用来源 SSE 回归在 main 上记录红灯，再按顺序 cherry-pick `26c97a16`、#2 七个非 merge 提交、`53c72856`、`1d1aadf0`，保留来源；冲突逐处保留 main 的命名与生命周期。只从提示文档工作树导入指定提案及链接，重生成目录，不实施提案。

依次运行窄测试、server/web/docs/Effect/deadcode/health/scripts/desktop 检查，再用隔离 home/work/端口和 scripted 帮工验证 CLI 身份、交活、watch、Provider 回环 HTTP、dictation dev/prod、实际打包入口与 CLI。子进程清除 OAR_*，不调用厂商或宿主凭据，不改变门禁。证据保存在主人指定的 publication-review/integration 目录，记录失败、重跑、退出码及清理。

## Alternatives considered

**覆盖来源分支整棵树**：会撤回 main 修复，拒绝。逐提交合并及测试证明语义。

**沿用旧绿灯**：来源没有验证组合后源码，旧打包阻塞也已失效，拒绝。

## Acceptance criteria

- 来源行为和最终文档齐全，无 #14 未完成代码，main 修复不回退。
- 最窄及完整检查串行通过，不降低预算或断言。
- 真服务、CLI、watch、Provider、听写、打包及清理有本轮证据。
- 干净提交，英文 PR 元数据明确回归与未验证项；不 push、开 PR 或合并。

## Risks

组合后打包 CLI 可能暴露源码路径依赖。确定性回归可在本单修复；需要付费或越界的验证报告限制。结束时将长期约定沉淀进相关子系统并删除此临时 Note，保留未实施的提示设计提案。
