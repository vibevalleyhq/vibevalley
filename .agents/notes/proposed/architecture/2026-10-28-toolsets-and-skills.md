# Agent Note: agent 带什么：工具集（toolsets）和技能（skill 模块），主人用 `/` 叫它们

Status: proposed

## Problem

一个 agent 能做什么由**工具**和**技能**决定，目前两样都分散在多处：

| 缺口 | 现状 | 问题 |
|---|---|---|
| 技能存三份且互不相通 | 1. 农场技能书存于 `config.json` 的 `skills` 字符串，勾选后整段正文拼进人设（`session/briefing.ts`）；2. 农机自带技能由 oar 只读列出；3. 本机 `.agents/skills` 目录仅 `Brain` 帮工与 CLI 扫描，管家固定 `noSkills` | 技能书每勾一个就每轮多带一份全文且不能带脚本/参考文件；管家完全用不上技能 |
| 工具按角色写死两张表 | `tool/` 固定按 `orchestrator`（28 个）和 `session`（10 个）二分 | 无法给某个帮工档案开放 `issue` 工具当拆单领班，也无法裁剪某个管家档案的工具 |
| 缺少 `/` 显式调用 | 输入框打 `/` 无响应 | 主人无法直接点名让管家或帮工按某份技能或内置快捷命令执行 |

## Proposal

### 1. 独立 `skill` 模块，统一为 Agent Skills 文件夹

新增 `apps/server/src/skill/`（排在 `agent` 之后、`session` 之前），一份技能固定为一个含 `SKILL.md`（frontmatter `name`、`description` 加正文）及附属文件的文件夹。按以下优先级现扫合并（同名取靠前）：

| 优先级 | 来源 | 路径 | 能否在工作台修改 |
|---|---|---|---|
| 1 | 仓库技能 | `<仓库>/.agents/skills/`、`.claude/skills/` | 否（随仓库仓库） |
| 2 | 农场技能书 | `$VIBEVALLEY_HOME/skills/<name>/`（取代 `config.json` 的 `skills` 段） | 能（新建、编辑、删除、从本机目录导入） |
| 3 | 本机全局 | `~/.agents/skills/`、`~/.claude/skills/` | 否 |
| 4 | 农机自带 | oar 探测清单 | 否（仅展示） |

### 2. 只给目录，正文按需读

- **进程内 `Brain`（管家、`vibevalley` 农机、CLI）**：去掉管家的 `noSkills`；将档案勾选的技能（及仓库技能）目录注入系统提示 `skills` 段，模型调 `load_skill` 时再读 `SKILL.md` 正文。
- **外部农机帮工**：在任务说明末尾附上已勾选技能的「名称、简介、`SKILL.md` 绝对路径」，由农机用自身读文件工具按需读取（农机自身已能扫到的不重复列）。

### 3. 档案级工具集（`Agent.toolsets`）

在 `Agent` 档案增加 `toolsets: Toolset[]`，`tool/` 用 `Record<工具名, Toolset>` 强制每个工具归组（漏归组编译报错）：

| 工具集 | 包含工具 | 默认拥有者 |
|---|---|---|
| `chat` | 频道读写、回应与收件箱查询 | 管家、帮工 |
| `memory` | 记性检索、新增与重写 | 管家、帮工 |
| `look` | 工单、帮工、diff、仓库、笔记与资源的只读查询 | 管家、帮工 |
| `issue` | 工单创建、修改、挪状态、派活、拆子工单、叫停与验收 | 管家（赋给帮工即为领班） |
| `cron` | 定时任务创建、查询与删除 | 管家 |
| `channel` | 频道创建与设置修改 | 管家 |
| `coding` | 本地文件读写、shell 与网页抓取（仅 `Brain` 内置，外部农机自带） | 帮工 |

- `toolsets` 仅主人可通过 `agent.update` 修改；管家工具表与帮工 `/mcp` 工具表均按调用方档案的 `toolsets` 过滤并在执行时二次校验。
- 接口表 `endpoints` 的 `can` 收窄为 `owner`、`remote` 与 `agent` 三档。

### 4. 输入框 `/` 命令

在聊天页与农场田头输入框输入 `/` 弹出当前目标 agent 可用的技能与 3 个内置命令（`/stop` 叫停管家、`/issue <标题>` 记备选工单、`/remember <话>` 记一条记性）：
- 前后端共用 `packages/protocol/src/rules/` 的 `commandOf(text)` 解析开头的 `/<名字> <参数>`。
- 技能命令仍走 `channel.message.send`，消息记录 `command: { name, args }` 供界面渲染为技能标签；投递给 agent 时由服务端在当轮输入附上该技能的 `SKILL.md` 正文，不改动系统提示前缀。

## Alternatives considered

- **技能正文继续整段拼进人设**：每勾一个技能每轮都重复计费，且无法携带附属参考文件。
- **把技能复制进帮工 worktree 的 `.claude/skills/`**：会污染仓库工作区的 `git status`，收工还需清理；在说明中给出绝对路径让帮工按需读取更干净。
- **在前端把 `/` 技能展开成全文再发进频道**：会让聊天记录塞满几百行技能指令；在服务端投递给 agent 那一步展开，频道只留主人原话与标签。
- **为 `/` 命令另起 `skill.invoke` 接口**：复用 `channel.message.send` 才能直接继承 `sendKey` 幂等、工单串归属与 Mailbox 路由。

## Acceptance criteria

- `$VIBEVALLEY_HOME/skills/<name>/SKILL.md` 可在设置页增删改；勾给管家后系统提示仅含名称与简介且可经 `load_skill` 读正文，勾给外部农机后任务说明包含其路径。
- 帮工默认 `/mcp` 不含 `issue_create`；主人为其档案勾选 `issue` 工具集后可建单与拆单，取消勾选后下一次调用立即被拒。
- 输入框打 `/` 可补全技能与内置命令；发送 `/<技能> ...` 后频道展示标签、当轮 agent 输入包含技能正文。

## Risks

- 管家启用技能目录后系统提示前缀会增长，每条简介硬限 160 字，修改后需重放管家评测集验证前缀缓存与工具选择。
- 赋予 `issue` 工具集的领班帮工可能连续派满并发槽位，必要时需在 `Issue.start` 限制派工深度。
