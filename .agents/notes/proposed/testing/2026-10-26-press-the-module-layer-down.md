# Agent Note: 把模块层往下压：项目检查成端口，项目的决定成规则

Status: proposed

## Problem

服务端模块层测试耗时中，项目模块（`project.test.ts`、`github.test.ts`）占比较高，主要花在两处：
- **项目检查每次起真实子进程**：测试合并门禁（检查期间分支变化被拒、检查失败不合并、检查超时中止）时，每次都在新 worktree 下生成并执行 `.vibevalley/check` shell 脚本。
- **分支决策与 git 命令耦合在 `project.ts`**：释放工作区时是否保留分支、合并走快进还是合并提交或拒绝，夹在多次 git 调用之间，测试每种分支组合都得构造多个真实 git 仓库。

## Proposal

1. **项目检查抽成端口（`ProjectHooks.check`）**：
   - 真实实现留在 `project/check.ts`，仅在针对它的专属测试中跑真实 shell 脚本（覆盖不存在、通过、失败截断输出、不可执行、超时杀进程组）。
   - 合并与 PR 模块测试注入内存检查函数，直接返回成功、失败或停在 `gate()` 门前验证并发竞态。
2. **项目决策抽成纯函数（`project/rules.ts`）**：
   - 将「工作区状态 + 分支领先数 → 释放或保留」与「检查前后 commit + 冲突状态 → 合并或拒绝」抽为纯函数，在 20ms 规则层用表格穷尽测试；`project.ts` 只做 git 读写并按纯函数结论执行。

## Alternatives considered

- **把项目测试里的 git 也换成假实现**：合并、worktree 和引用更新是最容易出错的边界，必须保留真实 git 仓库；只把外部 `.vibevalley/check` 脚本抽成端口。
- **拆成两个独立服务**：会增加跨服务调用与组装成本；模块内拆出 `rules.ts` 纯函数即可进入规则层测试。

## Acceptance criteria

- 合并与 PR 模块测试不再拉起真实 `.vibevalley/check` 子进程；真实脚本仅在 `check.ts` 专属测试中运行。
- 释放与合并的分支决策抽出纯函数并在规则层覆盖，沉淀进 [项目](docs/subsystems/project.md) 后删除本 Note。

## Risks

- 内存检查替身的返回结构（退出码、尾部输出截断、超时文案）必须与真实适配器严格对齐。
