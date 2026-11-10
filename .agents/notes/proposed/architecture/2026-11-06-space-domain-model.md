# Agent Note: Space 核心业务概念模型（Space、Repo、Worktree、Issue、Pkm 与执行体）

Status: proposed

## Problem

当前代码与文档（[docs/concepts.md](docs/concepts.md)、[docs/reference/concept-map.md](docs/reference/concept-map.md)）存在 3 处核心业务概念错位：

| 错位点 | 现状定义 | 实际业务语义与问题 |
|---|---|---|
| 空间与仓库同名混淆 | 顶层叫 `Space`，单个 Git 仓库叫 `Repo`（`issue.repo`、`apps/server/src/repo`） | 现实中一个仓库空间（`Space`）下包含多个代码仓库（`Repo`）；把单个仓库叫 `Repo` 导致无法表达“同仓库多仓库”与 `owner/repo` 仓库全名 |
| `Space` 资产边界割裂 | `repos/`、`worktrees/`、`pkm/` 在 `workRoot` 下，但 `issue`、`channel`、`artifact` 与 `pkm` 索引存在 `~/.vibevalley/db`（`home`）下 | 切换 `Space` 目录时，代码仓库与笔记随目录切换，但工单看板与聊天记录仍混在宿主全局库中，未形成独立隔离单元 |
| `Issue` 与 `Repo` 归属倒置 | 工单模板、槽位与统计紧绑单层 `repo` 文件夹名 | `Issue` 应归属 `Space`：一张工单可以不绑定 `Repo`（纯调研或写 `Pkm`），也可以绑定某个 `Repo` 切出 `Worktree` 改代码，或拆出子工单分别改不同 `Repo` |

## Proposal

确立以 **`Space`（空间）** 为业务隔离单元的核心领域模型。本机运行环境拆分为 **`Host`（宿主）** 与 **`Space`（空间）** 两层，每个 `Space` 自包含 **`Repo`（仓库）**、**`Worktree`（工作树）**、**`Issue`（工单）** 与 **`Pkm`（笔记）** 四大业务资产。

### 1. 概念层次总览

```text
Host（本机宿主 ~/.vibevalley：全局设置、模型密钥、农机探测、全局档案模板）
└── Space（业务隔离空间 <space>/：一个完整仓库或业务域）
    ├── Repo（代码仓库 <space>/repos/<owner>/<repo>）
    │   └── Worktree（工单工作树 <space>/worktrees/<owner>/<repo>.<issueNumber>）
    ├── Issue（空间工单：可无 Repo，或关联一个 Repo 切出 Worktree，可拆分子工单）
    │   ├── Assignment（责任指派 → Agent 档案）
    │   └── IssueThread（工单评论串 → Channel）
    ├── Pkm & Artifact（空间知识与产出：<space>/pkm/* 笔记库、共创 Artifact）
    └── Space DB（空间状态库 <space>/.vibevalley/space.db：工单、会话、频道、记忆、索引）
```

### 2. 核心业务实体定义

#### 2.1 空间与宿主层

| 概念 | 建议代码名 | 现行代码名 | 业务定义与边界 |
|---|---|---|---|
| **宿主（Host）** | `HostConfig` | `ServerConfig.home`（`~/.vibevalley`） | 本机安装的 VibeValley 运行容器。只存跨空间共享的 API 密钥（`settings.json`）、农机探测结果（`Runtime`）、全局 Agent 模板与进程日志 |
| **空间（Space）** | `Space` / `SpaceState` | `SpaceState` / `workRoot` | 顶层业务隔离单元。一个 `Space` 对应磁盘上一个目录，拥有自己独立的 `repos/`、`worktrees/`、`pkm/`、全局准则 `AGENTS.md` 与空间数据库 |

#### 2.2 `Space` 下的四大业务资产

| 概念 | 建议代码名 | 现行代码名 | 身份标识（ID） | 磁盘落盘位置 | 核心不变量 |
|---|---|---|---|---|---|
| **仓库（Repo）** | `Repo` | `Repo` | GitHub 仓库用全名 `<owner>/<repo>`（如 `vibevalleyhq/vibevalley`）；本地自建仓库用 `<repo>` | `<space>/repos/<owner>/<repo>` | 1. 只管主分支（`main`）检出、远端同步、`.vibevalley/setup` 与 `.vibevalley/check` 门禁脚本；<br>2. 帮工不在 `Repo` 主检出目录直接改代码（除非档案显式关闭 `worktree`） |
| **工作树（Worktree）** | `Worktree` / `Workplace` | `Workplace` | `<repo>#<issueNumber>` | `<space>/worktrees/<owner>/<repo>.<issueNumber>` | 1. 由 `Issue` 在指定 `Repo` 上开工时从基线分支切出，对应分支 `vibevalley/issue-<issueNumber>`；<br>2. 首次切出自动运行 `.vibevalley/setup`；<br>3. 同工单重开或换帮工复用同一 `Worktree`；合并或 PR 合入后自动清理 |
| **工单（Issue）** | `Issue` | `Issue` | 内部 UUID + 空间内递增编号 `#<number>` | `<space>/.vibevalley/space.db`（`issue` 表） | 1. `Issue` 归属 `Space`，通过可选字段 `repo?: RepoId` 关联目标仓库；<br>2. 状态机固定为 `backlog`（待规划）→ `todo`（待办）→ `in_progress`（处理中）→ `in_review`（待验收）→ `done` / `canceled`；<br>3. 父工单可经 `issue.split` 拆分为带 `blockedBy` 依赖的子工单，子工单通过门禁后先合入父分支 |
| **笔记（Pkm）** | `Pkm` (`PkmPage` / `PkmBlock`) | `Pkm` | 页面相对路径（如 `notes/architecture.md`） | `<space>/pkm/{daily,notes,sources}` | 1. Markdown 文件是唯一真相，SQLite 仅存反链、术语与评论索引；<br>2. 归属当前 `Space`，供助手立项与帮工查阅空间背景知识 |
| **Artifact（Artifact）** | `Artifact` | `Artifact` | `ArtifactId` | `<space>/.vibevalley/artifacts/` + `space.db` | 挂在频道或工单上的可交付块文档（`blocks`）或交互式网页（`html`），按版本或块操作（`op`）留痕 |

#### 2.3 执行与协同实体（谁在 `Space` 里干活）

| 概念 | 代码名 | 业务定义与职责 | 与 `Space` 资产的关系 |
|---|---|---|---|
| **档案（Agent）** | `Agent` | 持久化的智能体身份配方：绑定农机（`runtime`）、模型、人设（`persona`）、工具集（`toolsets`）与技能（`skills`） | 按 `role` 分为 **`orchestrator`（助手）** 与 **`worker`（帮工档案）** |
| **助手（Orchestrator）** | `Orchestrator` | 用户在 `Space` 里的总助：常驻频道听用户说话，查阅 `<space>/pkm`，创建/起草/拆分/初审 `Issue`，调度帮工 | 工作目录指向 `<space>/repos`，不直接绑死单个 `Worktree` |
| **帮工（Session）** | `Session` | 某个 `Agent` 档案接活后生成的持续执行上下文，跨多轮对话、休眠与服务重启保留身份 | 处理工单时工作目录绑定该工单的 `Worktree`（`<space>/worktrees/...`）；私聊时绑定独立会话目录 |
| **一轮（Run）** | `Run` | `Session` 从一次触发（`RunTrigger`）开始、到调用 `issue_report` 汇报结束的完整执行回合 | 每一轮消费信箱中的 `Trigger`，产出代码提交、结构化验收检查（`checks`）、待答问题（`questions`）与新增记性（`remember`） |
| **农机（Runtime）** | `RuntimeInfo` | 驱动 `Session` 的底层编码程序：内置 `vibevalley`（进程内 `Brain`）或经 `@botiverse/oar` 驱动的 `claude`、`codex`、`pi` | 受宿主的并发槽位与每个 `Repo` 的空位上限（`maxSessions`）约束 |
| **接入与信箱（Ingress & Mailbox）** | `Ingress` / `Mailbox` | 将 7 类输入源（用户消息、GitHub PR CI 与评审、定时任务 `Cron`、外部聊天连接器）标准化为 `Trigger` 并路由投递 | 把外部 GitHub PR 的 CI 失败日志或评审意见精准投递回对应 `Issue` 的在场 `Session` |

### 3. 核心业务流转不变量（四个基本关系）

1. **`Space` 1 : N `Repo`**：一个 `Space` 下可挂载多个 `Repo`；每个 `Repo` 以 `<owner>/<repo>`（或本地短名）唯一标识。
2. **`Issue` 0..1 : 1 `Repo` → 0..1 `Worktree`**：
   - 当 `Issue.repo` 为空时，帮工在独立上下文目录执行调研、问答或编写 `<space>/pkm`，不切分 Git 分支。
   - 当 `Issue.repo` 指定具体仓库且档案开启 `worktree` 时，系统为 `(Issue.repo, Issue.number)` 唯一绑定一棵 `<space>/worktrees/<owner>/<repo>.<issueNumber>` 工作树与 `vibevalley/issue-<issueNumber>` 分支。
3. **`Issue` 1 : N `Assignment` 1 : N `Session` 1 : N `Run`**：
   - 一张 `Issue` 同一时刻由一个 `Agent` 档案负责（`Assignment`），由一个在场 `Session` 持有 `Worktree` 写锁；
   - 该 `Session` 可经历多轮 `Run`（如：首轮编码 → 提交 PR → 收到 CI 失败 `Trigger` 开启第二轮修复 → 收到评审意见开启第三轮修改）。
4. **交付门禁闭环**：
   - 任何 `Worktree` 在合入 `Repo` 主分支、合入父工单分支或推送 GitHub PR 前，工作树必须无未提交改动（`git status --porcelain` 为空），且必须通过该 `Repo` 下的 `.vibevalley/check` 检查。

### 4. 模型收敛实施步骤

#### 步骤 1：将空间状态库迁入 `<space>/.vibevalley/`，实现 `Space` 自包含
1. 修改 [apps/server/src/infra/config.ts](apps/server/src/infra/config.ts)：当未显式指定 `db` 路径时，将空间业务表（`issue`、`session`、`channel`、`artifact`、`memory`、`pkm_*`）存入 `<space>/.vibevalley/db`，仅将 `settings.json`（API 密钥）留在 `~/.vibevalley`。
2. 保证切换 `workRoot`（即切换 `Space`）时，看板工单、代码仓库、工作树与笔记同步切换。

#### 步骤 2：支持 `<owner>/<repo>` 全名标识与两级目录寻址
1. 修改 [packages/protocol/src/repo/schema.ts](packages/protocol/src/repo/schema.ts) 与 [apps/server/src/repo/repo.ts](apps/server/src/repo/repo.ts)：允许仓库名包含单层 `<name>` 或两级 `<owner>/<repo>`。
2. 克隆 `https://github.com/<owner>/<repo>` 时，支持直接落盘至 `<space>/repos/<owner>/<repo>`，对应工作树落盘至 `<space>/worktrees/<owner>/<repo>.<issueNumber>`。

#### 步骤 3：将领域术语与协议字段从 `Repo` 平滑收敛为 `Repo`
1. 在协议层（[packages/protocol/src/repo](packages/protocol/src/repo/schema.ts)）、服务端服务（[apps/server/src/repo/repo.ts](apps/server/src/repo/repo.ts)）与文档（[docs/concepts.md](docs/concepts.md)、[docs/reference/concept-map.md](docs/reference/concept-map.md)）中，将指代单个 Git 仓库的 `Repo` / `repo` 正名为 `Repo` / `repo`，将顶层 `Space` 正名为 `Space`。

## Alternatives considered

- **保持 `Repo` 代表单个 Git 仓库，不引入 `Space` 与 `Repo` 区分**：会持续让用户与模型把“仓库空间”与“单个代码仓库”混为一谈，且一旦一个空间包含前后端或协议等多个仓库，命名与概念就会立刻冲突。
- **让一张单工单同时直接切出多个 `Repo` 的 `Worktree`**：会让单张工单的 `Changes`、冲突检测、`.vibevalley/check` 与 PR 状态机变成多仓库笛卡尔积；保持“一张原子工单（或子工单）对应至多一个 `Repo`，跨仓需求通过父工单拆分子工单（`issue.split`）分别指向各自 `Repo`”能使合并与回滚保持原子性。
- **继续把 `issue` 表留在全局 `~/.vibevalley/db` 中**：会导致 `Space` 只隔离了磁盘上的 `repos/` 和 `pkm/`，却没有隔离工单与频道，破坏 `Space` 作为独立隔离单元的完整性。

## Acceptance criteria

- [docs/concepts.md](docs/concepts.md) 与 [docs/reference/concept-map.md](docs/reference/concept-map.md) 明确区分 `Host`、`Space`、`Repo`、`Worktree`、`Issue`、`Pkm`、`Agent`、`Session`、`Run` 的边界与基数关系。
- 每个 `<space>` 根目录下自包含 `repos/`、`worktrees/`、`pkm/` 与空间级状态数据，切换 `<space>` 时工单看板与仓库、笔记一致切换。
- `Repo` 支持以 `<owner>/<repo>` 全名或本地短名寻址，切出的 `Worktree` 与之严格一一对应。
- `vp run docs:verify` 与 `vp check --deny-warnings` 全部通过。

## Risks

- 将 `Repo` 重命名为 `Repo` 会触及协议字段（`issue.repo`、`session.repo`）、SQLite 列名与前端路由（`/repos`）；应分两步执行：先完成 `<space>` 目录与 `<owner>/<repo>` 寻址收敛，再通过单次协议与表结构迁移完成 `repo → repo` 改名。
