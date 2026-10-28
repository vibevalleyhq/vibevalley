# Agent Note: 管家和帮工的工具就是接口：名字、字段、谁能调都照接口表

Status: proposed

## Problem

接口已经统一成 `POST /api/v1/<模块>[/<名词>]/<动词>`，命令行也从接口表生成；管家和帮工的工具却是另写的一套，名字、参数、谁能调都和接口对不上：

- **名字没有一条规矩**：动词在前（`read_chat`、`open_channel`）、在后（`channel_say`、`graph_split`）、没有（`channel_inbox`、`channel_settings`），或者只有一个词（`check`、`tell`、`accept`、`roster`、`issues`、`graphs`）。同一个列表管家叫 `roster`、帮工叫 `session_list`。
- **和接口叫法不同**：`channel_say` 是 `channel.message.send`，`tell` 是 `issue.comment.create`，`open_channel` 是 `channel.create`，`channel_settings` 是 `channel.update`。
- **同一个概念几个参数名**：频道是 `target`、`channel`、`name`（接口是 `id`）；派给谁是 `agent`（接口是 `assignee`，挪状态时接口自己又叫 `agent`）；状态是 `to`（接口是 `status`）；正文多是 `text`，`tell` 叫 `message`；记性的范围管家是 `project` 字符串，帮工是 `all_projects` 布尔。
- **一个工具做几件事，三种写法**：`task_edit` 带 `remove` 就是删；`issue_status` 按 `to` 的取值做四件不同的事；`graph_action` 用 `action` 枚举。
- **两套东西撞名**：agent 自己的待办（`task_add`、`task_update`、`task_graph`）和种植计划（`task_edit`、`task_action`）都叫 task。
- **谁能调写在两处**：接口表的 `can` 标了 23 个接口 `orchestrator`，但不放行任何东西；管家和帮工能调什么由 `tool/tool.ts` 的两张表决定。

加一个工具不会被提醒去对接口，加一个接口也不会有工具；名字和参数一年比一年漂。

## Proposal

**农场的工具是接口给模型的那一面**：每个工具由一个接口声明，名字由接口推出，参数取接口的字段，接口的 `can` 说谁能调。工具仍然手写给模型看的说明、默认值和回话（[先有能力，再有入口](docs/subsystems/core.md) 的「不从接口生成」照旧）；变的是契约只有一份。

### 1. 规矩

- **名字**：接口名的点换成下划线，小驼峰拆成下划线：`channel.message.send` 是 `channel_message_send`，`graph.task.act` 是 `graph_task_act`。工具定义时只写接口，名字由它算出，没有第二处写名字。
- **参数**：只用接口输入里有的字段，名字一样（`id`、`assignee`、`status`、`text`、`replyTo`）。工具可以收人读的写法：频道写 `#前端`、工单写 `#41`、帮工写 `@w3`，它们和编号放在同一个字段里，由拥有它的服务认出来（命令行本来就这样收）。
- **只给 agent 的参数**：接口里没有、只对模型有意义的（`channel_message_send` 的 `anyway`、`confirm`：发之前先看没读过的话），在工具上明写成「只给 agent」，每个带一句为什么。
- **谁能调**：接口的 `can` 里有 `orchestrator` 才进管家的工具表，有 `session` 才进帮工的；能力表多一列「帮工」。不在 `can` 里的接口，agent 拿不到。
- **一个动作一个工具**：不藏布尔、不靠取值分支；接口本来就收一个动作的（`graph.act`、`graph.task.act`），字段就叫 `action`。
- **agent 自己的手不是接口**：读写文件、跑命令、读网页、读技能、开子 agent、它自己的待办和记忆文件，是 agent 框架（`agent/brain`）自己的工具，不经过农场；照编码 agent 通行的叫法（`read_file`、`bash`、`web_fetch`、`load_skill`、`spawn_agent`）。它自己的待办改叫 `todo_add`、`todo_update`、`todo_list`，task 只留给种植计划。

### 2. 检查

`tool/tool.test.ts` 查：每个农场工具的名字是它的接口推出来的；接口的 `can` 有调用它的人；参数都是接口的字段，或者明写了只给 agent；接口表里标了 `orchestrator`、`session` 的，都有工具。能力表（`vp run capabilities`）的「管家」「帮工」两列从这里来，不再「只是记下」。

### 3. 改名表

管家：

| 现在 | 以后 | 接口 |
|---|---|---|
| `projects` | `project_list` | `project.list` |
| `channels` | `channel_list` | 新：`channel.list` |
| `open_channel` | `channel_create` | `channel.create` |
| `channel_settings` | `channel_update` | `channel.update` |
| `recurrence` | `recurrence_create` | `recurrence.create`（`when` 照接口收一个对象） |
| `list_recurrences` | `recurrence_list` | `recurrence.list` |
| `cancel_recurrence` | `recurrence_delete` | `recurrence.delete` |
| `issues` | `issue_list`、`issue_get` | `issue.list`（加过滤：状态、字、项目、条数、关上的、等主人的）、`issue.get` |
| `check` | `issue_get` | `issue.get`（回话带上在干的帮工和最后一次汇报） |
| `issue_create` | `issue_create` | `issue.create`（`agent` 改 `assignee`） |
| `issue_update` | `issue_update` | `issue.update`（`agent` 改 `assignee`） |
| `issue_status` | `issue_status_update` | `issue.status.update`（`to` 改 `status`，换人的 `agent` 在接口里也改 `assignee`） |
| `tell` | `issue_comment_create` | `issue.comment.create`（`message` 改 `text`） |
| `accept` | `issue_review` | 新：`issue.review` |
| `changes` | `issue_diff_get` | `issue.diff.get` |
| `roster` | `session_list` | `session.list` |
| `stop` | `session_stop` | `session.stop`（`id` 收帮工或工单） |
| `dismiss` | `issue_status_update`（`status` 是 `canceled`） | `issue.status.update`：请走帮工就是取消它的工单，两条路做的是同一件事 |
| `read_chat` | `channel_message_list` | `channel.message.list`（只给 agent：`unread`） |
| `graph_split` | `graph_split` | `graph.split` |
| `graphs` | `graph_list`、`graph_get` | 新：`graph.list`、`graph.get` |
| `task_edit` | `graph_task_update`、`graph_task_delete` | `graph.task.update`、`graph.task.delete` |
| `graph_action` | `graph_act` | `graph.act` |
| `task_action` | `graph_task_act` | `graph.task.act` |
| `memory_search` | `memory_search` | 新：`memory.search` |
| `memory_add` | `memory_create` | `memory.create` |

帮工：

| 现在 | 以后 | 接口 |
|---|---|---|
| `channel_say` | `channel_message_send` | `channel.message.send`（只给 agent：`anyway`、`confirm`） |
| `read_chat` | `channel_message_list` | `channel.message.list` |
| `channel_inbox` | `channel_unread_list` | 新：`channel.unread.list`（调用者自己没读的） |
| `session_list` | `session_list` | `session.list` |
| `memory_search` | `memory_search` | `memory.search`（范围是 `project`，空是全部，和管家一样） |
| `memory_add` | `memory_create` | `memory.create` |
| `doc_read` | `doc_get` | `doc.get` |
| `doc_append` | `doc_block_create` | 新：`doc.block.create` |
| `doc_update` | `doc_block_update` | 新：`doc.block.update` |
| `issue_split` | `issue_split` | 新：`issue.split` |

新接口给主人也能用（命令行、页面），规则在拥有它的服务里；`issue.list` 的过滤从 `tool.ts` 挪进工单服务。

### 4. 做的顺序（一个 PR，每步一个提交）

1. 接口：加新接口和字段、改 `assignee`、标 `can`；主人的处理函数；能力表加「帮工」列；重写 `client.ts` 和命令行的黄金数据。
2. 工具：按接口声明、改名改参数、拆 `task_edit` 和 `issues`、合 `roster`；检查；`parameters.json` 重写。
3. 提到工具名的提示和词：管家的提示、频道规矩、私聊和派活的话、页面里过程面板的工具名。
4. agent 自己的手：待办改 `todo_*`。管家的记性不用改：`memory_create` 替帮工档案记，名字是管家自己时拒绝、让它用 `remember`，两条路不重。
5. 管家评测的样例：样例里记着的工具名和参数照改名表改，`want` 里提到的也改。
6. 文档：频道、管家、计划、执行、地基的子系统文档和能力表；本篇沉淀后删掉，[管家是一份档案，只是能力多](.agents/notes/proposed/architecture/2026-10-17-orchestrator-is-an-agent.md) 里和本篇相反的第 3 节删掉。
7. 真模型重放管家的评测（花钱，先问主人）。

## Alternatives considered

- **工具和接口分开，`can` 只留 `owner`、`remote`**（[管家是一份档案，只是能力多](.agents/notes/proposed/architecture/2026-10-17-orchestrator-is-an-agent.md) 第 3 节）：理由是模型的工具和接口不是一个形状。说明、默认值和回话确实不是，所以工具照样手写这些；可名字、字段和谁能调没有理由不同，分开的结果就是现在这样漂。本篇取代那一节。
- **工具整个从接口生成**：模型要的说明、默认值（不写频道就是自己的工单串）、人读的写法、回话的句子，接口里都没有；硬生成会把管家的提示变差（[先有能力，再有入口](docs/subsystems/core.md)）。
- **只改名，不加检查**：名字一年后还会漂；检查让「加一个工具就要对上一个接口」成为编不过的事。
- **参数用 snake_case**：接口的字段是小驼峰，工具跟着它，一个概念一种拼法。

## Acceptance criteria

- 管家和帮工的每个农场工具，名字都由一个接口推出，参数是那个接口的字段或明写的只给 agent 的字段，接口的 `can` 有调用者；`tool.test.ts` 查。
- 能力表有「管家」「帮工」两列，和两张工具表一致。
- 提示、频道规矩、页面、文档里没有旧的工具名（`stale-names.ts` 查旧名）。
- 管家评测的样例照新名能离线跑；真模型重放的结果附在 PR 里（或写明没跑和原因）。

## Risks

- 工具的名字、说明和参数是管家提示的开头：改了要重跑真模型的评测，花钱，先问主人。
- 外部编码 agent 的技能、记忆里可能写着旧名字（`channel_say`）；工具列表每次开工从 `/mcp` 当场拿，旧名字只在它们自己的笔记里，不兼容。
