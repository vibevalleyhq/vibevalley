# Agent Note: Space 核心业务概念模型（Space、Repo、Worktree、Issue、Pkm 与执行体）

Status: proposed

## Problem

`<space>/{repos,worktrees,pkm}` 目录收敛与 `.vibevalley/{setup,check}` 自举门禁已上线（见 [概念](docs/concepts.md)、[仓库](docs/subsystems/repo.md)），但 `Space` 作为完整隔离单元还剩两处缺口：
- **空间状态未随 `Space` 隔离**：切换 `work_root` 时，`repos/`、`worktrees/` 与 `pkm/` 随之切换，但工单、频道、会话与 Artifact 状态仍混在宿主全局库（`$VIBEVALLEY_HOME/db` 或同一个 `database.url`）中，看板与聊天未随空间隔离。
- **仓库仅支持单层短名**：`apps/server/src/repo/repo.ts` 的 `repoName` 仅允许单层目录名，同空间克隆不同组织的同名仓库或按 GitHub `<owner>/<repo>` 全名寻址时会冲突。

## Proposal

1. **按 `Space` 隔离空间状态**：
   - 本地单机默认模式下，空间业务数据随 `<space>` 隔离（仅 API 密钥 `settings.json`、全局档案模板与农机探测留在宿主 `$VIBEVALLEY_HOME`）；在[多机共享服务端](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md)的 Postgres 模式下，明确以独立库/schema 或空间标识隔离，保证切换 `Space` 时看板、频道、仓库与笔记一致切换。
2. **支持 `<owner>/<repo>` 两级仓库寻址**：
   - 扩展 `packages/protocol/src/repo/schema.ts` 与 `apps/server/src/repo/repo.ts` 的仓库名校验，兼容本地单层 `<repo>` 与 GitHub 两级 `<owner>/<repo>`（禁止 `..` 与符号链接越界）。
   - 克隆 `https://github.com/<owner>/<repo>` 时支持落盘至 `<space>/repos/<owner>/<repo>`，工单 worktree 对应 `<space>/worktrees/<owner>/<repo>.<工单号>`。

## Alternatives considered

- **让单张工单直接切出多个仓库的 `Worktree`**：会使 `Changes`、冲突检测、`.vibevalley/check` 与 PR 状态机变成多仓库笛卡尔积；保持「一张原子工单至多绑定一个 `Repo`，跨仓工作经 `issue.split` 拆分子工单」才能保证合并与回滚原子性。
- **保持工单与频道留在宿主全局库**：`Space` 只隔离磁盘目录而不隔离看板与讨论，切换空间会出现找不到对应仓库的悬空工单。

## Acceptance criteria

- 切换 `<space>` 时，工单看板、频道、Artifact 与该空间的 `repos/`、`worktrees/`、`pkm/` 同步隔离切换，且密钥与全局设置仍在宿主共享。
- `Repo` 支持 `<owner>/<repo>` 与单层 `<repo>` 两种合法寻址，worktree 路径与之唯一对应，越界路径被拒绝。
- 更新 [概念](docs/concepts.md)、[架构](docs/architecture.md) 与 [仓库](docs/subsystems/repo.md) 后删除本 Note，`vp run server:check` 与 `vp run docs:verify` 通过。

## Risks

- `<owner>/<repo>` 含斜杠会影响 URL 路径参数与 worktree 目录命名，接口路由与磁盘路径拼接须覆盖编码及路径穿越单测。
