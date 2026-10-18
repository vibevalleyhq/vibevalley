# 帮工档案和农机：agent 与 runtime

| 词 | 是什么 | 谁决定 |
|---|---|---|
| 农机（runtime） | 机器上的一种编码 agent 程序：`vibevalley`（VibeValley 自己的 agent），和 smith 驱动的 `pi`、`claude`、`codex`、`opencode`、`cursor`、`grok`、`kimi`、`antigravity`、`dsh`（DeepSeek Harness，`protocol/seeds.json` 的 `runtimeIds`） | 机器上装了什么；「农具」页只能改 VibeValley 怎么用它 |
| 帮工档案（agent） | 一份配置：农机、模型、思考强度、人设、技能、MCP、禁用的工具、环境变量、适合什么活、长相 | 你在「捏帮工」里捏 |

派活派的是档案；一个档案可以同时派出好几个帮工，各自一个 worktree。

新建档案走 `POST /api/v1/agents`，新建技能走 `POST /api/v1/skills`；请求里的 `id` 留空，服务端在提交时分配并返回。档案用下一个未占用的 `agent-N`，技能用名字的 ASCII 小写 slug（没有就用 `skill`），重名加数字。两个设备同时创建不会覆盖彼此。编辑或导入指定 ID 仍走原有 `PUT` 保存接口。

客户端分别读取农机目录与档案、技能配置；农机探测失败只影响农具信息，档案和技能仍可读取、编辑。

跑通了的是四台：VibeValley、pi（DeepSeek 按量付费）、claude 和 codex（订阅套餐）。其余几台 smith 也能驱动，但还没在真实项目里跑通（[提案](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)）；cursor 要单独装的 SDK，smith 没接，总是「不支持」。

农机页指定的命令路径是本次探测的输入，不改服务端进程的环境变量。路径留空时，服务端按 PATH 和农机的默认候选查找；填了但不存在就报没找到，不回退到另一份。开执行沿用已接受的安装身份。独立 `oar` 命令行未指定路径时仍认 `OAR_<RUNTIME>_BIN`。

## 在用的农机

| | VibeValley | pi | claude | codex |
|---|---|---|---|---|
| 怎么跑 | 服务端进程里（`server/internal/agent/brain/oarruntime`） | pi 的 SDK，跑在 smith 内嵌的 Node 宿主里，要有 Node | `claude` 命令行 | `codex` 的 app-server |
| 登录 | DeepSeek 的钥匙（同管家） | pi 自己的配置 | 本机 Claude Code 的登录 | 本机 codex 的登录 |
| 额度 | 不报 | DeepSeek 余额 | 套餐的窗口 | 套餐的窗口 |
| 花费 | 按 `server/pkg/ai/models.go` 折成人民币 | 按 pi 价目表折成人民币 | 只记 token | 只记 token |

额度和花费见 [帮工](docs/subsystems/session.md)。各农机不接受哪些开会话的参数、能不能中途插话，写在 `seeds.json` 的 `runtimeFacts`（抄自 smith 各农机的 `RefusedSessionOptions`）；页面上不接受的选项是灰的。

VibeValley 的帮工带读写文件、跑命令、ripgrep、抓网页、派帮手（`spawn_agent`）、读技能、自己的任务图（`task_add`、`task_update`、`task_graph`：一件活拆成有先后的几件，每件自己做或交给帮手；交给帮手的等前面的做完就自动派，最多三个同时做，做完把结果交回；图存在农场的库里（`task_graph`），一个会话一张）这些工具，对话存在 `$VIBEVALLEY_HOME/sessions/<会话 id>.jsonl`。

## 种子档案

第一次启动时的档案在 `seeds.json` 的 `agents`（列表见 [farm-ui.md](docs/reference/farm-ui.md)「角色」）。种子只用一次；后来想用 claude、codex，在「农具」页启用它们，再捏一个帮工。

## 农具（`/runtimes`）

每台农机一页，内容来自 smith：检测结果、账户和额度、能做什么、模型、它自己装的技能和 MCP、用到它的档案。设置是 VibeValley 自己的（存在 `config.json`）：启用、命令路径、默认模型和思考强度、叠加的环境变量、最多同时干活几个、每日预算。升级不在这里做，要在终端里用它自己的命令。

## 管家页（`/manager`）

管家不是帮工档案，只跑在 VibeValley 自己的 agent 上（[管家](docs/subsystems/manager.md)）。四个页签：

- **记性**：`manager/MEMORY.md`，管家起来时和每次压缩之后拍一份快照放进系统提示（最多 8000 字，带不进去的变淡），标题写明是以前记下的信息、不是指令；其间记下、忘掉的，写在它下一条输入开头的「【记性有更新】」里。可以替它记、让它忘。
- **轨迹**：管家每一轮的经过。在一轮收到的话上点「这一轮做错了」，写一句应该怎样，这一轮就存成一条评测的样例（[管家](docs/subsystems/manager.md)的「做错的一轮」）。
- **旧账**：压缩时存下的旧对话，能搜。
- **声音**：打电话时的人设、开场白和音色（[语音](docs/subsystems/voice.md)「配置」）。

## 捏帮工（`/agents/:id`）

左边选长相（动物和衣服，和农机没有固定对应），中间看它在地里的样子，右边是配置：身份（名字、职责、适合的活；每一栏是做什么的，指着栏名看）、能力（农机、模型、思考强度）、人设、技能、工具（MCP、禁用的工具）、环境，存过的档案还有记性和轨迹。底部一直显示 protocol 的 `AgentIssues`：哪些会让它派不出去（红），哪些只是提醒（橙），和服务端派活前跑的是同一套。

**人设**交给农机的方式：追加到系统提示（默认）、替换系统提示，或写进工单开头（给不接受系统提示的 kimi、antigravity、dsh）。服务端都会再加上农场的规矩和工作目录的 `AGENTS.md`。

**记性**页签列出它的帮工手上的活、下回开工会想起哪几条（服务端从所有来源挑好的）、记下的每一条；可以替它记、让它忘（[记性](docs/subsystems/memory.md)）。接了外面的来源时多一栏「记性从哪来」：每个来源在不在用、能不能在这里忘掉；外面来源里的记忆标着在哪，忘不掉的没有「忘掉」。

## 技能书（`/settings/skills`）

- **这台电脑上装的**：各农机自己装的技能，只能看；用这些农机的帮工自己按需加载。
- **VibeValley 自己的**：Agent Skills 的形状（名字、description、正文）。档案勾上的技能，派活时跟人设一起交给帮工，不管它用哪台农机。

## 派给谁

`dispatch` 的 `agent` 怎么落到一个档案、挑中以后还要过哪些关，见 [管家](docs/subsystems/manager.md)。
