# Agent Note: agent 带什么：工具集（toolsets）和技能（skill 模块），主人用 `/` 叫它们

Status: proposed

## Problem

一个 agent 由「档案 + 跑它的农机」定下，它能做什么由两样东西决定：工具（能调什么）和技能（会什么做法）。两样现在都没有一个家。

**技能有三份，互不相通：**

| 来源 | 在哪 | 怎么交给 agent | 问题 |
|---|---|---|---|
| 技能书（`config.json` 的 `skills`，「设置 › 技能」） | `Skill { id, name, description, body }`，正文存在 JSON 里 | 档案勾上的，正文整段接在人设后面（`session/rules.ts` 的 `instructions`） | 勾十个就是十份正文进每一轮的提示；不是 Agent Skills 的文件夹，带不了脚本和参考文件；管家用不上 |
| 农机自己装的（oar 的清单） | 各农机的目录 | 农机自己按需加载 | 只读地列出来，农场不知道哪个帮工看得见哪个 |
| 本机目录 | `~/.agents/skills`、`~/.claude/skills`、工作目录的 `.agents/skills` | 只有 VibeValley 自己的 agent 扫：提示里列名字，`load_skill` 读正文（[VibeValley 自己的 agent](docs/subsystems/brain.md#自己带的东西)） | 管家的大脑是 `noSkills`；外部农机上的帮工看不到技能书里的 |

**工具按角色写死两张表。** `tool` 的管家表和帮工经 `/mcp` 的表由接口的 `can`（`orchestrator`、`session`）定。想让一个帮工能拆子工单（领班），或给某个管家少几样工具，没有地方改。「管家是一份档案，只是能力多」这篇 Note 提过按档案的 `can` 放行，没做；本篇取代它并删掉它（原文在 git 里），名字改成 `toolsets`（照 Hermes Agent：一组工具一个名字，按 agent 开关）。

**主人没有直接叫一个技能的办法。** 要管家照某个做法干，只能在话里描述；输入框里打 `/` 什么也没有。

## Proposal

### 1. 一个 `skill` 模块，技能是 Agent Skills 的文件夹

`apps/server/src/skill`（`Skills` 服务，排在 `agent` 之后、`session` 之前）管技能的发现、目录和读取。一份技能就是一个文件夹：`SKILL.md`（frontmatter 的 `name`、`description`，加正文），可以带别的文件（脚本、参考），和 Claude Code、Codex、Hermes 认的格式一样。

技能从这些地方来，同名的取靠前的：

| 次序 | 来源 | 位置 | 能不能在农场里改 |
|---|---|---|---|
| 1 | 项目 | 项目目录的 `.agents/skills/`、`.claude/skills/` | 不能（跟着仓库） |
| 2 | 农场的技能书 | `$VIBEVALLEY_HOME/skills/<name>/` | 能（「设置 › 技能」新建、改、删、从文件夹加进来） |
| 3 | 本机 | `~/.agents/skills/`、`~/.claude/skills/` | 不能 |
| 4 | 农机自己装的 | oar 的清单 | 不能，只列出来 |

- 技能书从 `config.json` 搬到文件夹：照「内部不留兼容」，旧的 `skills` 段作废，不搬数据。`skill.*` 接口改成按名字（`name` 照 Agent Skills 的规矩：小写字母、数字、`-`）。
- `skill.list` 给合起来的目录：每份的名字、说明、来源、路径、哪些农机自己就看得见它。目录每次现扫（和模板目录一样），不缓存。
- 读一份 `SKILL.md`（frontmatter、正文）和 `load_skill` 留在 `packages/agent` 的 `skills.ts`：包不认识农场。`skill` 模块定这个 agent 能用哪些，交给大脑一份清单（名字、说明、路径），不再让大脑自己扫目录。

### 2. 技能怎么交给 agent：只给目录，正文按需读

每个 agent 拿到的是**目录**（名字、说明、`SKILL.md` 的路径），不是正文：

- **VibeValley 自己的 agent**（管家、农机 `vibevalley` 上的帮工、命令行）：目录进系统提示的 `skills` 段，正文用 `load_skill` 读，照旧。管家去掉 `noSkills`，它的技能是档案勾上的那些。
- **外部农机上的帮工**：目录写进交给农机的说明（人设后面一段「## 可用的技能」：名字、说明、路径），帮工用自己的读文件工具读正文。农机自己就看得见的（来源 4，和它会扫的本机目录）不重复写。
- **档案勾什么**：`Agent.skills` 是技能的名字。没勾的不进这个 agent 的目录；项目里的技能对在这个项目干活的帮工都给（它们是仓库的规矩）。

正文不再整段接进人设。

### 3. 工具集（`toolsets`）是档案的字段

`Agent.toolsets: Toolset[]`，`Toolset` 是封闭的一组（`ToolsetValues`）。每个工具属于一组，归属写在 `tool` 模块里（`Record<工具, Toolset>`，加工具时不归组编不过）：

| 工具集 | 里面是什么 |
|---|---|
| `chat` | 在频道里读、说、看收件箱 |
| `memory` | 搜、记、忘自己的记性 |
| `look` | 看工单、帮工、改动、项目、频道（只读） |
| `issue` | 建工单、改、挪状态、开工、换人、叫停、验收 |
| `graph` | 种植计划 |
| `cron` | 定时 |
| `channel` | 开频道、改频道设置 |
| `coding` | 读写文件、跑命令、抓网页（只有 VibeValley 自己的 agent 有这组；外部农机自带） |

- 默认值是 `agent` 模块的规则：管家是 `chat`、`memory`、`look`、`issue`、`graph`、`cron`、`channel`；帮工是 `chat`、`memory`、`look`、`coding`。给一个帮工加上 `issue`，它就是能拆子工单的领班。
- 只有主人能改（`agent.update` 从主人的入口来）；工具不能改任何档案的 `toolsets`。
- 管家的工具表和 `/mcp` 的工具表都按调用者档案的 `toolsets` 过滤，执行时再查一次：干活时被改小，下一次调用就拒。
- 接口的 `can` 只剩 `owner`、`remote` 和「agent 能调」这一档；哪个 agent 能调由 `toolsets` 定。
- 管家的工具表在大脑起来时定下（提示开头不变），改了 `toolsets` 下次起来生效；页面上写明。

### 4. 输入框里的 `/`

主人在输入框（聊天页和田头）打 `/`，弹出能用的命令，选中或接着打字过滤：

- **技能**：`/<技能名> <要它做的>`。列出的是这句话交给的那个 agent 能用的技能（这处的管家，或 @ 的那个帮工的档案）。
- **内置的几个**，都对到已有的动作：`/stop`（叫停这处的管家，`orchestrator.stop`）、`/issue <标题>`（记一张工单，`issue.create`，不开工）、`/remember <一句话>`（替管家记一条，`memory.create`）。不加新能力。

一条带命令的话怎么走：

1. 认命令是两边都跑的纯函数（`packages/protocol/src/rules` 的 `commandOf(text)`：开头的 `/名字` 和后面的字），页面用它高亮和弹出，服务端用它定。
2. `channel.message.send` 收到时，服务端照目录认出是内置命令还是技能；认不出的照普通的话发，不拒。
3. 技能命令照普通的话存进频道，消息带 `command: { name, args }`，页面画成一个标签加后面的字。
4. 交给 agent 时，这条话的开头写明「主人要你用技能「<名字>」」，接着是技能的正文（服务端读的，不靠 agent 再读一次），最后是主人的字。这是一条普通的输入，不改提示开头。

### 5. 页面

- 「设置 › 技能」变成一份目录：按来源分组，技能书的能新建、改（`SKILL.md` 的编辑器）、删、从本机文件夹加进来；别的只读，写明在哪。
- 档案页：勾技能（从目录里挑）、勾工具集（每组一行，悬停看里面的工具）。管家的档案页也有这两样。
- 输入框：`/` 的弹层，键盘上下选、回车填进去。

### 做的顺序（一个 PR，一步一个提交）

1. `skill` 模块：发现、目录、读取；技能书搬成文件夹；`skill.*` 接口按名字；大脑改用它。
2. 交给 agent：目录代替正文；管家去掉 `noSkills`；外部农机的说明里写目录。
3. `toolsets`：字段、默认值、`tool` 的归组、管家表和 `/mcp` 的过滤和执行时的检查；`can` 收窄。
4. `/` 命令：`commandOf`、消息的 `command`、交给 agent 的写法、内置的三个。
5. 页面：技能目录、档案页的两样、输入框的弹层。
6. 文档：本篇沉淀进[档案和农机](docs/subsystems/agent.md)、[VibeValley 自己的 agent](docs/subsystems/brain.md)、[管家](docs/subsystems/orchestrator.md)、[田头](docs/subsystems/channel.md)，删掉本篇。

## Alternatives considered

**技能正文继续整段接进人设。** 实现最少；但每勾一个技能，每一轮都多付一份正文的钱，也带不了脚本和参考文件。只给目录、按需读，是 Claude Code、Codex、Hermes 共同的做法。

**技能书继续存在 `config.json`。** 一个 JSON 字符串里放不了文件夹；主人也不能用编辑器或 git 管它。

**把技能复制进每个帮工的工作目录（`.claude/skills/`），让农机自己发现。** 农机原生就会加载；但要往主人的仓库或 worktree 里写文件，`git status` 里会多出东西，收工还要清。路径写进说明，帮工自己读，效果一样、不碰仓库。

**`can`（「管家是一份档案，只是能力多」）。** 本篇取代它：做法相同（按档案放行、只有主人能改、执行时再查），名字改成 `toolsets`，分组按现在的工具重排（那篇的 `dispatch`、`tell` 这些工具已经不在了）。放弃了按角色分档（每多一种用法多一档）和细到每个工具（主人要勾二十几个框）。

**`/` 命令在页面里展开成正文再发。** 页面不读技能的文件；话放在频道里也会是一大段正文。展开放在交给 agent 的那一步，频道里只留主人打的字。

**技能命令另起一个接口（`skill.invoke`）。** 主人打 `/` 是在跟这处的 agent 说话，走 `channel.message.send` 才有回执、重发不成两条、串和路由这些已有的规矩。

## Acceptance criteria

- 一份放在 `$VIBEVALLEY_HOME/skills/review/SKILL.md` 的技能：在「设置 › 技能」里看得到、能改；勾给管家以后，管家的系统提示里有它的名字和说明、没有正文，`load_skill` 读得到正文；勾给一个 claude 档案，派活时交给农机的说明里有它的名字、说明和路径。
- 项目目录 `.agents/skills/` 里的技能，在这个项目干活的帮工都看得到。
- 只有默认工具集的帮工经 `/mcp` 列不出、调不了 `issue_create`；主人给它的档案加上 `issue` 后能建工单；干活时去掉，下一次调用被拒。`Record<工具, Toolset>` 漏一个工具编不过。
- 输入框打 `/` 列出这处的管家能用的技能和三个内置命令；发 `/review 看看 #41` 以后，频道里是一个「review」标签加「看看 #41」，管家这一轮的输入里有技能的正文；`/stop` 停下这处的管家。
- 服务端测试、页面 e2e、`vp run desktop:test` 通过；改了管家的工具表或提示，照 [acceptance/orchestrator-evals.md](.agents/skills/acceptance/orchestrator-evals.md) 真模型重放（花钱，先问主人）。

## Risks

- **管家带上技能目录，提示开头变长。** 每条最多 160 字；技能多时只列勾上的。改了管家的提示要重放评测。
- **外部农机读不到说明里的路径**（权限、沙箱）：先在 claude 和 codex 上各真跑一次；读不到的农机退回把正文接进说明。
- **`toolsets` 写错就是权限写错**：给错一个档案 `issue`，它就能开工、花钱。默认值要小，只有主人在档案页能改，PR 里单列默认值的改动。
- **领班派活会连锁**：同时干活的上限还在，但一个领班可以把它占满。第一版不限，要限加在 `Issues.start`。
