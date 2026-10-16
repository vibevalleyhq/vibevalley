# 帮工档案和农机：agent 与 runtime

两个词分开用：

| 词 | 是什么 | 谁决定 |
|---|---|---|
| 农机（runtime） | 机器上的一种编码 agent 程序：VibeValley、pi、claude（Claude Code）、codex、opencode、cursor、grok、kimi、antigravity。smith（oar 的 Go 移植，`server/pkg/smith`）负责发现它、开会话、读它的模型和账户 | 机器上装了什么；农具房只能改 VibeValley 怎么用它 |
| 帮工档案（agent） | 一份配置：用哪台农机和模型、思考强度、人设、技能、MCP 服务器、禁用的工具、环境变量、默认项目，适合什么活，在农场里是哪种小动物、穿什么 | 你在「捏帮工」里捏出来 |

管家派活派的是档案。一个档案可以同时派出好几个帮工（各自一个 worktree），帮工的名字就是档案的名字，重名时后面加编号。

现在用四台农机：VibeValley（服务端里 VibeValley 自己的 agent）、pi（DeepSeek 按量付费）、claude 和 codex（各自的订阅套餐）。其他农机在农具房里停用，逐个接回（[先打磨 pi](../.agents/notes/implemented/simplification/2026-10-10-pi-only-for-now.md)；[接回 claude 和 codex](../.agents/notes/implemented/feature/2026-10-11-claude-and-codex.md)；[其余的提案](../.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)）。

## 在用的农机

| | VibeValley | pi | claude | codex |
|---|---|---|---|---|
| 怎么跑 | 服务端进程里的 VibeValley 自己的 agent（`server/pkg/agent`；当农机用的是 `pkg/agent/oarruntime`，见 [server](../server/README.md)） | 本机装的 pi 的 SDK，跑在 smith 内嵌的一个 Node 宿主里，所以要有 Node | `claude` 命令行 | `codex` 的 app-server |
| 模型和登录 | DeepSeek：首页「设置」里的 API Key，再是 `DEEPSEEK_API_KEY`，没有就用 pi 配好的密钥；模型 `deepseek-flash`（默认）、`deepseek-v4-pro`，思考强度 `high`、`max` | pi 自己的配置（DeepSeek 的密钥） | 本机 Claude Code 的登录 | 本机 codex 的登录 |
| 额度 | 不报 | DeepSeek 余额 | 套餐的窗口（当前会话、本周） | 套餐的窗口（本周） |
| 花费 | 按 VibeValley 的模型表（`server/pkg/ai/models.go`）折成人民币，可以设每日预算 | 按内置的 pi 价目表（`internal/runs/pi_prices.json`，不含 pi 配置里自加的模型）折成人民币，可以设每日预算 | 只记 token | 只记 token |
| 用量什么时候报 | 一轮结束时 | 每次调模型 | 一轮结束时 | 一轮里随时 |
| 额度用完 | 每日预算用完就不派 | 余额或每日预算用完就不派 | 任何一个窗口用到 100% 就不派，写明哪天几点重置 | 同 claude |

这几台都能中途插话，都接受人设、MCP 服务器和禁用的工具。VibeValley 的帮工用的工具是读写文件、按原文改、列目录、ripgrep、跑命令、抓网页、派帮手，加上会话给的 MCP 服务器（农场的 `/mcp` 工具在里面）；它的对话存在 `$VIBEVALLEY_HOME/helpers/<会话 id>.jsonl`，接着上次的会话就从这里读。没有 DeepSeek 密钥时，农具房里它是「不支持」，写明缺什么。服务端从 Claude Code 里启动也没关系：smith 开 claude 会话时去掉了父会话的环境标记。cursor 在农具房里总是「不支持」：它要单独装的 SDK，smith 没有接。

## 种子档案

第一次启动时的档案（`server/internal/protocol/seeds.json`）：

| 档案 | 职责 | 农机 | 小动物 |
|---|---|---|---|
| 后端老周 | 写接口、改 server、跑测试 | pi | 熊 |
| 测试小吴 | 跑测试、修测试、盯 CI | pi | 兔子 |
| 前端阿郑 | 页面、场景、交互动画 | pi | 小狐狸 |
| 文档员 Kimi | 通读文档、写 README、整理说明 | pi | 猫 |
| 情报 Grok | 查资料、读外部文档、调研方案 | pi | 猫头鹰 |
| 夜班反重力 | 杂活、小改动 | pi | 浣熊 |
| Claude 师傅 | 读大代码库、重构、查难缠的 bug | claude | 熊（冬装） |
| Codex 老匠 | 照工单把功能做出来，改到测试通过 | codex | 小狐狸（雨衣） |
| Pi 实验员 | 写原型、试新做法 | pi | 刺猬 |

名字里的 Kimi、Grok、反重力是 runtime 的名字，但这几个档案跑在 pi 上。种子只在第一次启动时用；已有的配置里要用 claude、codex，在农具房启用它们，再捏一个用它们的帮工。每种动物的性格见 [game-ui.md](game-ui.md)「角色」。

## 农具房（`/runtimes`）

每台农机一页（农具房里画成一件农机：拖拉机、水车、手推车……，右下角钉着它那家 agent 的 logo，好认出是哪个；logo 来自 LobeHub Icons，像素皮肤下是 codex 重画的像素版），内容都来自 smith：

- **检测结果**：可用（版本、命令路径、是命令行还是随 smith 一起装）、没找到、不支持（带原因）。可以重新检测。
- **账户**（紧跟在检测结果下面，和「能做什么」并排）：精力瓶和每个窗口的体力条；pi 是 DeepSeek 余额和今天花了多少。
- **能做什么**：能不能中途插话（steer）；跑在服务端进程里还是单独进程；不接受哪些开会话的参数，各自的原因；smith 对它提供哪些查询。
- **设置**（VibeValley 自己的）：要不要让帮工用它；命令路径（对应 smith 的 `OAR_<RUNTIME>_BIN`）；默认模型和思考强度；叠加到每个会话的环境变量；最多同时干活几个；pi 和 VibeValley 还有每日预算（元）。
- 模型列表；它自己装的技能、MCP 服务器、工具清单（smith 用各农机自己的方式读，读的是帮工干活的根目录 `VIBEVALLEY_WORK_ROOT` 下看到的样子；读不到的写「这台农机不报告」）；可用的更新（升级要在终端里做，服务端不替你改这台机器）。
- 用到它的档案，和「用它捏一个新帮工」。

各农机不接受的参数（smith 各农机的 `RefusedSessionOptions`，抄在 `server/internal/protocol/seeds.json` 的 `runtimeFacts` 里）：

| 农机 | 不接受 | 中途插话 |
|---|---|---|
| VibeValley | `launchArgs`、`serviceTier`（跑在服务端进程里，VibeValley 不传这两个）；思考强度只有 `high`、`max` | 能 |
| pi | 都接受 | 能 |
| claude、codex | 都接受 | 能 |
| opencode | `disallowedTools` | 能 |
| cursor | 没接，总是「不支持」 | — |
| grok | `disallowedTools` | 能 |
| kimi | `systemPrompt`、`appendSystemPrompt`、`disallowedTools` | 不能，排到这一轮之后 |
| antigravity | `systemPrompt`、`appendSystemPrompt`、`effort` | 不能，排到这一轮之后 |

## 管家页（`/manager`）

帮工页的第一张卡片是管家，点开是它自己的页面（Flutter 的 `app/lib/desk/manager/manager_page.dart`）。管家不是帮工档案：它只跑在 VibeValley 自己的 agent 上（[server.md](server.md)「管家」），没有农机可选，也没有技能和地。页面上有四个页签：

- **记性**（`/manager`）：它的 `foreman/MEMORY.md`，新的在前，每条写着是管家自己记的还是你交代的、哪天记的。整份放在它每次请求的系统提示里，最多 8000 字。超出部分的旧条目带不进去，在列表里变淡，标「太旧了，带不进系统提示」。可以替它记一条（在文件里写成「主人交代：……」，管家读的时候也知道是谁说的），也可以让它忘掉一条。
- **轨迹**（`/manager/trajectory`）：管家每一轮的经过，和帮工的干活过程一样显示：收到的话、调的每个工具（点开看参数和结果）、说的话。
- **旧账**（`/manager/archive`）：对话压缩时存下的原文（`foreman/archive/`），新的在前。能搜一个词（和它的 `search_archive` 用同一套搜法），也能点开整个文件看。
- **声音**（`/manager/voice`）：打电话时管家的人设、开场白、出错时说的话和音色（[voice.md](voice.md)「配置」）。

## 捏帮工（`/agents/:id`）

三栏，像游戏的捏人界面：

- **左：长相**。选动物（熊、兔子、小狐狸、猫、猫头鹰、刺猬、浣熊）和衣服（农夫、园丁、雨衣、冬装）。长相只表示这个档案是谁，和农机没有固定对应。
- **中：它的地**。它站在田边，下面的按钮切换六个动作（待命、走路、干活、琢磨、欢呼、发愁）和地里的样子。
- **右：配置**，六个页签（存过的档案多「记性」和「轨迹」）：
  - 身份：名字、一句话职责（管家挑人时读）、适合的活（关键词）、启用。
  - 农机：选农机（卡片上标着装没装）、模型、思考强度，以及这台农机能做什么。换农机会清掉模型和思考强度，长相不变。
  - 人设：正文，加交给农机的方式（见下）。农机不接受的方式是灰的，鼠标停上去看原因。
  - 技能：从技能书里勾；也列出农机自己已经装的技能。
  - 工具：MCP 服务器（stdio 或 http）；禁用的工具，农机报告的工具点一下就能加。农机不接受时整块变灰并说明原因。
  - 环境：默认项目（相对 `VIBEVALLEY_WORK_ROOT`）、每个帮工一个 git worktree、环境变量。
  - 记性（`app/lib/desk/shared/memory_panels.dart`）：从上到下是
    - **手上的活**：它的每个帮工那件活做到哪了（`job`）。
    - **下回开工会想起**：选一个项目，可以再填这一轮的话，列出现在开工会放在前面的几条和用了多少字。用的是服务端开工时同一套挑法（protocol 的 `Pick`），只是看，不记「想起过」。
    - **替它记一条**：项目可以从工作目录里的项目里挑，留空就是所有项目。
    - **记下的**：能按全部、所有项目、某个项目筛。每条写着哪个项目、谁记的（帮工的名字，或「你记的」）、多久以前、想起过几次和上次什么时候（或「还没想起过」）。离 300 条上限不到 10 条时，最久没用、下次最先丢的那几条变淡，标「快忘了」。每条都能让它忘掉。

  记性怎么用见 [server.md](server.md)「记性」。
  - 轨迹：它派出去的每个帮工，新的在前，写着名字、项目、什么时候接的活、还在场还是什么时候走的、工单。点开是那个帮工的干活过程，收工以后也看得到（步骤默认留 30 天，帮工本身一直列着；[server.md](server.md)「轨迹」）。
- 底部一直显示 `agentIssues` 的结果：哪些问题会让这个档案派不出去（红），哪些只是提醒（橙）。这些检查和 smith 开会话时的检查一致，服务端派活前也跑同一套。思考强度按模型查：选了模型就看那个模型有哪几档；模型留空时看这台农机的默认模型（农具房里设的，没设就是农机自己说的默认，比如 VibeValley 农机是 DeepSeek Flash，只有 high、max）。

**人设**交给农机的三种方式：

| 方式 | 落到 smith | 适合 |
|---|---|---|
| 追加到系统提示 | `SessionOptions.appendSystemPrompt` | 默认。保留农机自带的做事方式 |
| 替换系统提示 | `SessionOptions.systemPrompt` | 你清楚要整段换掉的时候 |
| 写进工单开头 | 人设放在第一张工单前面 | 农机不接受系统提示时（kimi、antigravity）。新建这些农机的档案时自动选它 |

不管哪种方式，服务端都会在后面加上农场的规矩和工作目录的 `AGENTS.md`（[server.md](server.md)「帮工」）。

## 技能书（`/skills`）

两部分；最上面的搜索框按名字、说明、哪些农机有它（VibeValley 自己的还有正文）筛两部分，空格隔开的每个词都要对上，不分大小写：

- **这台电脑上装的**：各农机自己装的技能，从农机的技能清单里来（见上面「农具」），同名的合成一条，写明哪些农机有它、在哪找到的（`installedSkills`）。只能看：用这些农机的帮工会自己按需加载，不用在档案里勾；要改就去它的文件里改。每次打开这页都重新问一遍服务端。
- **VibeValley 自己的**：VibeValley 的技能库，每个技能是 Agent Skills 的形状：名字、什么时候用（description）、正文。档案勾选技能，派活时技能正文跟人设一起交给帮工（「## 技能名」接正文），不管它用哪台农机。新装的农场这里是空的；原来种下、没改过的示例技能启动时会拿掉（[理由](../.agents/notes/implemented/simplification/2026-10-12-real-data-only.md)）。

## 派给谁

一句话里每件事单独挑。管家从你的话里看出点了谁，填进 `dispatch` 的 `agent`（可以不填），农场按这个顺序落到一个档案上：

1. 填的是档案的名字或 id（「让前端阿郑……」）：就是它。
2. 填的是农机（「让 codex……」）：这台农机上第一个能派的档案。
3. 田头窗口里选定了某个档案（「下一单派它」）：用它。
4. 都没有：拿工单去匹配每个档案「适合的活」，在能派的档案里取命中最多的；一样多取靠前的。

种植计划的步骤指定了档案就派它，没指定按第 4 条挑；拆计划的帮工也按这个顺序挑（可以点名）。规则写在 `server/internal/runs/rules.go` 的 `ChooseAgent`，管家和计划共用。

挑中之后检查：档案停用、农机没装或停用、配置有错、余额或今天的预算用完、同时干活的人数到了上限（[server.md](server.md)「额度、花费和上限」），都会拒绝，管家照原因说一句，同时发一条提醒。

## 存在哪

服务端存在 `$VIBEVALLEY_HOME/config.json`，第一次启动时用种子。记性在服务端的数据库里（`farm.db` 的 `memories` 表）。接口见 [architecture.md](architecture.md)「HTTP 接口」。
