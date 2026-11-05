# Agent Notes

一篇 **Agent Note** 是一份待执行的架构或功能计划，记录要做什么、为什么、放弃了什么、怎么算做完。

- **做完即沉淀并删除**：计划上线后，将长期成立的模型、不变量与放弃的路沉淀进 [子系统文档](docs/subsystems/README.md)，并删除原 Note。
- **当前现状归 `docs/`**：这里不复制现行接口、字段或清单（现行文档见 [文档地图](docs/README.md)）。
- **中英混合约定**：正文写中文；供 [scripts/agent-notes.ts](scripts/agent-notes.ts) 机器校验的标记（`# Agent Note:`、`Status:` 与英文二级章节名）保持英文原样。

## 位置和命名

每篇 Note 的路径格式为 `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`（日期为首次提出该话题的日期）。

### 生命周期（第一层目录）

| 目录 | 含义与流转规则 |
|---|---|
| `proposed/` | 实施前审过的提案（尚未实施或仅实施了一部分） |
| `implemented/` | 刚上线、尚未沉淀进子系统的过渡态；沉淀进 `docs/subsystems/*.md` 后立即删除 |
| `rejected/` | 考虑过但否决的提案；仅当其理由能防止诱人且实际的错误时保留，否则删除 |

- **互相引用写仓库根路径**：写 `[题目](.agents/notes/proposed/architecture/2026-…-….md)`，以便 `scripts/doc-links.ts` 自动检查。
- **被新决策取代时直接删除旧 Note**：把仍成立的部分并入新 Note，不留「已被取代」的横幅（历史留在 git 中）。
- **目录清单自动生成**：[CATALOG.md](.agents/notes/CATALOG.md) 由 `vp run notes:catalog` 生成，并由 `vp run notes:verify` 校验，不手改。

### 类别（第二层目录）

类别是封闭集合，以 [scripts/agent-notes.ts](scripts/agent-notes.ts) 为准：

| 类别 | 管什么 |
|---|---|
| `feature` | 主人或模型能感知的新能力 |
| `bug-fix` | 修一个缺陷，或补上一次事故暴露的缺口 |
| `simplification` | 删掉代码、行为或范围，不加新能力 |
| `architecture` | 上线代码的结构性决策：包关系、模块边界与运行时模型 |
| `process` | 代码周边的工具、门禁和流程（非运行时行为） |
| `testing` | 测试设施和测试策略 |

## 什么时候写

- 只为将来的非平凡工作或代码解释不了的结构决策新增或更新 Note；局部样式和机械改动免写。
- 更新已拥有该决策的 Note 即可，不另起重复 Note。
- 一篇 Note 不能被改成另一个决策：用新 Note 取代它（在 `## Alternatives considered` 写明取代关系）并删掉旧 Note。

## 文件格式

每篇 Note 均由 `vp run notes:verify`（[scripts/agent-notes.ts](scripts/agent-notes.ts)）校验。

### 开头

前三行固定为：

```markdown
# Agent Note: <标题>

Status: <状态>
```

`Status:` 必须与所在生命周期目录一致：
- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <一行理由>`

### 章节结构

| 生命周期 | 必需章节（按顺序） | 说明 |
|---|---|---|
| `proposed/` | `## Problem`、`## Proposal`、`## Alternatives considered`、`## Acceptance criteria`、`## Risks` | 特有技术小节可夹在 `Proposal` 与 `Alternatives considered` 之间 |
| `implemented/` | `## Problem`、`## Decision`、`## Alternatives considered`、`## Consequences` | 禁止保留 `Proposal`、`Plan`、`Migration plan`、`Acceptance criteria` |
| `rejected/` | `## Problem`、`## Proposal`、`## Alternatives considered` | 冻结的提案，否决结论写在 `Status:` 行 |

- **`## Alternatives considered` 必填**：每个真实考虑过的替代方案写一段（开头加粗方案名，或用 `### Why not <X>?`），说明为什么没选。
