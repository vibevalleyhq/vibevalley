# 档案、农机和技能书

档案（profile，代码里是 `Agent`）是一份 agent 的配置：用哪台农机、哪个模型、思考强度、人设、技能、MCP、禁用的工具、环境变量、默认项目、适合什么活、长什么样。档案有角色（`role`）：管家（`orchestrator`）常驻、带队、自己不干活，可以有好几个（[管家](docs/subsystems/orchestrator.md)）；帮工（`worker`）是派活派的那种，一个帮工的档案可以同时派出好几个帮工。档案可以自己捏，也可以从模板（`AgentTemplate`）装：模板是一份 agent 的配方，一个文件夹里一份 `agent.json` 加一份人设 `persona.md`，内置的随包发，主人也能把本机的文件夹加进来。农机（runtime）是机器上的一种编码 agent 程序，农场经 oar 探测它装没装、有哪些模型、额度和清单，派活前照它能接受什么查档案。技能书（`Skill`）分两份：各农机自己装的，只读地列出来；VibeValley 自己的技能库，档案勾上的跟人设一起交给帮工。农场里档案是小动物的长相和名字，农机是「农具」，技能书在「设置」里。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 档案、技能库、农机设置的存取：`config.json`、事务、模板（读、装、照模板更新、加进来）、默认管家、角色的规则、新建时的 id | 管家怎么用它的档案（模型、只接 DeepSeek，[管家](docs/subsystems/orchestrator.md)） |
| 档案没填的外观补齐（`withCast`），和页面的 `castOf` 挑同一只动物 | 长相怎么画、动物和衣服的贴图（[农场的皮](docs/subsystems/farm.md)） |
| 农机的注册表（`registry`）、探测、模型列表、清单（技能、MCP、工具）、缓存和推给页面 | 额度怎么读成字、钱的那条「派不出去」、价目和今天的花费（[帮工](docs/subsystems/session.md)「额度、花费和上限」） |
| 农机接受哪些开会话的选项（`runtimeFacts` 和适配器的 `refusedSessionOptions`） | 选项怎么交给 oar、人设和技能怎么拼进会话、安装身份怎么用（[帮工](docs/subsystems/session.md)） |
| 档案照现在的农机派不派得出去（`agentProblems`，`agent.validate`、`assess`）；派活时用哪个模型、思考强度、环境变量、安装（`resolve`） | 挑哪个档案（`session.ChooseAgent`，[管家](docs/subsystems/orchestrator.md)「挑档案」）；派活的其余关口（[工单](docs/subsystems/issue.md)） |
| 技能库的存取；这台机器上装的技能从农机清单里来 | 档案的记性（[记性](docs/subsystems/memory.md)） |
| | 捏帮工、模板、农具、技能书、管家页的界面（[界面清单](docs/reference/farm-ui.md#界面清单)）；内置模板的名单见本篇「内置的模板」 |
| | VibeValley 自己的 agent 怎么跑、自己的任务（`packages/agent`，[VibeValley 自己的 agent](docs/subsystems/brain.md)） |

## 在哪

- **`apps/server/src/agent/agent.ts`**（`Agents`）：读写 `config.json`、事务 `change`、默认管家（没有就从内置的 `orchestrator` 模板装上）、模板的装和更新、角色的规则（`roleProblem`，`orchestrators`、`isOrchestrator`）、新建档案和技能时分配 id、补外观（`withCast`、`castHash`）。`packages/agent` 是 VibeValley 自己的 agent（[VibeValley 自己的 agent](docs/subsystems/brain.md)）。
- **`apps/server/src/runtime`**（`Runtimes`）：`runtime.ts` 注册表（`registryOf`）、探测、缓存、合并农机拒绝的选项、额度的定时任务读取、今天的花费、`assess`、`resolve`、`check`；`rules.ts` 的 `agentProblems`、`moneyStop`、额度的字（纯函数，黄金数据 `testdata/rules.jsonl.gz`）；`price.ts` 价目；`dsh.ts` DeepSeek Harness；`pi.ts` 读 pi 自己的设置。
- **模板**：`apps/server/src/agent/template.ts` 读一个模板文件夹（`readTemplate`）、内置的目录（`builtInTemplates`，`templates/<id>/`，次序在 `templates/index.json`）、本机加进来的（`addedTemplates`，`$VIBEVALLEY_HOME/agent-templates/<id>/`），照模板做出档案（`profileOf`）和照模板更新（`updatedFrom`）。
- **种子**：`apps/server/src/agent/seeds.json` 的 `defaultSettings`（农机设置的默认）、`runtimeIds`（农场认的农机和顺序）、`runtimeFacts`、`runtimePresets`、`fallbackPreset`（农机的名字和长相）；`seed.ts` 读它（`factsOf`、`runtimeIds`、`presetOf`、`runtimeLabel`）。页面不读它：农机的名字、长相和能做什么随 `runtime.list` 的每个 `RuntimeInfo` 给（`preset`、`facts`）。
- **家目录**：`$VIBEVALLEY_HOME/config.json`（`agents`、`skills`、`settings` 三块）；今天的花费 `spend.json` 归[帮工](docs/subsystems/session.md)。
- **接口**：`agent.list`、`agent.validate`、`agent.create`、`agent.update`、`agent.delete`，`agent.template.*`（`list`、`install`、`update`、`add`、`delete`），`skill.*`，`runtime.list`、`runtime.refresh`、`runtime.setting.update`（[capabilities.md](docs/reference/capabilities.md)）；处理函数在 `handlers.ts`。农机的新样子不进核心状态，经 `Core.runtime` 发一条侧事件，页面从窄事件流收到。命令行 `vibevalley runtime chat <农机>` 用同一张注册表。
- **页面**：`apps/web/src/features/agent/`（档案列表 `AgentsPage.tsx`，管家在上、帮工在下；模板目录 `TemplatesPage.tsx`（`/agents/templates`）；档案页上的来源和更新 `FromTemplate.tsx`；捏帮工和帮工的档案页 `AgentPage.tsx`；管家的档案页 `OrchestratorProfile.tsx`，`/agents/new?role=orchestrator` 新建）、`features/runtime/RuntimesPage.tsx`（农具）、`features/runtime/SkillsPage.tsx`；数据在 `base/query.ts`（`useAgents`、`useRuntimes`）、`base/agents.ts`（`useWorkAgents` 是帮工、`useOrchestrators` 是管家、`orchestratorLookOf`、`useAgentProblems` 问 `agent.validate`）；`features/runtime/skills.ts`（`installedSkills`）、`ui/runtimes.ts`（`runtimeName`）、`ui/cast.ts`（`castOf`）。

## 模型和不变量

- **角色（`role`）是封闭的两种**（`AgentRoleValues`）：`orchestrator`、`worker`，新建默认是帮工。派活用的档案（`agents()`、`named`、`chooseAgent`）只有帮工；全部档案（`all()`）和按 id 取的含管家。管家只在 `vibevalley` 上跑：保存、新建一份管家档案时农机不是它就拒绝（`roleProblem`）；默认管家（`defaultOrchestrator`）改成帮工拒绝。
- **职责（`duty`）和适合的活（`tags`）是两个字段，用法不同。**
  - `duty` 是一句话的「职责」（捏帮工「身份」页的栏名），给人和模型读：帮工栏、帮工列表、频道里帮工名字旁边显示它；管家的现状里每个能派的档案写成「- 名字（id …，农机）职责：<Duty>；适合的活：<Tags>」（`orchestrator/orchestrator.ts`），规划师的提示写成「- id：名字，职责：<Duty>；适合的活：<Tags>」（`session/rules.ts`），没填的那半不写；管家的提示让它按「适合的活」挑，和 `chooseAgent` 是同一个字段。挑档案不读它。
  - `tags` 是「适合的活」，一组关键词：工单没点名谁来做、主人也没选定时任务，`chooseAgent` 把工单的字转小写，数每个能派的档案有几个关键词（转小写）出现在里面，取最多的，一样多取靠前的，都是 0 也取第一个能派的。
- **档案、技能库、农机设置存在一个文件 `config.json`**，整份读进内存，`base.FileWriter` 写（先写临时文件再改名，同一个文件的写一个接一个）。每次改走 `change`：回调拿到一份完整独立的副本（嵌套的切片、字典、MCP 的参数和头、预算和上限的指针都复制），写盘成功后才换成当前版本；写盘失败当前版本不变。读出去的（`all`、`Agent`、`Settings`）也是副本，拿着它改不动服务端那份。
- **读不了或不符合形状的 `config.json` 不覆盖**：文件按档案、技能和农机设置的 Schema 读回；读取、解析或形状校验失败就改名成 `config.json.unreadable-<毫秒>` 留着，像新农场一样起；改不了名就不开机。
- **删技能同时解除档案引用**：`removeSkill` 在同一次 `change` 中删除技能和所有档案（包括管家）的对应技能 id，写盘失败两边都不变；再建同名技能不会让旧档案自动带上它。
- **新农场只有默认管家**：没有 `config.json` 时，档案只有从内置的 `orchestrator` 模板装的默认管家，加上配置 `agent.starters` 列出的内置模板（照列的次序，默认空；测试和沙箱用它装上全部内置的帮工），技能库空、农机设置空。帮工由主人在模板目录里挑着装。农机设置没存过的取 `defaultSettings`（启用、命令路径空、默认模型和思考强度空、无环境变量）。
- **模板是一个文件夹**：`agent.json` 是配置（`id`、`version`、`role`、`name`、`duty`、`tags`、`runtime`、`model`、`effort`、`personaMode`、`worktree`、`look`，除了前四项和帮工的 `runtime` 都能不写），`agent.en.json` 只覆盖英文的 `name`、`duty`、`tags`，`persona.md`、`persona.en.md` 是人设；照农场的语言读，英文缺的取中文。`id` 只用小写字母、数字和 `-`；管家的模板不写农机（写了不是 `vibevalley` 的不收），读出来就是 `vibevalley`；帮工的要写推荐的农机。不放环境变量的值、默认项目、启用、MCP 和技能：前三样跟着机器，后两样以后再说。读不通的说清是哪个文件、哪一栏。
- **装**（`agent.template.install`）：照模板建一份档案，id 是模板的 id，占了就 `-2`、`-3`，名字占了加「 2」「 3」；档案记着来源 `from: { template, version }`。同一个模板能装好几份。**照模板更新**（`agent.template.update`）：只在主人点了时做，用模板现在的版本盖掉职责、适合的活、人设和交给农机的方式、worktree，名字、长相、农机、模型、思考强度和这台机器的（环境、默认项目、启用、技能、MCP、禁用的工具）不动。页面在模板的 `version` 比档案记的大时提示。
- **加一个模板**（`agent.template.add`）：本机的一个文件夹，读得通、id 没被占就把那四个文件拷进 `agent-templates/<id>/`，不装。**删**（`agent.template.delete`）只删加进来的，内置的删不了，装好的档案留着。目录（`agent.template.list`）每次现读，带着每个模板装了哪几份；加进来的文件夹后来读不通就不列，记一条日志。
- **默认管家的档案每个农场都有**：开机时没有 `orchestrator`（`defaultOrchestrator`）就补上（名字「管家」、职责「替主人派活、转告结果」、农机 `vibevalley`），有了也把它的角色定成管家；删它回「默认管家删不了：每个农场至少有一个管家」。别的管家能删。
- **新建由服务端分 id**：`agent.create`、`skill.create` 的 `id` 要留空（填了回「新档案的 id 要留空；指定 id 请用保存」）。档案取下一个没占用的 `agent-N`；技能取名字转小写、非 `a-z0-9` 换成 `-` 的 slug，空了用 `skill`，重名加 `-2`、`-3`。分配在 `change` 的锁里，两台设备同时建不会撞。编辑和导入指定 id 走 `agent.update`、`skill.update`，路径里的 id 和请求里的不一样就拒绝。
- **外观缺的字段在读和存时补上**（`withCast`）：体型 `biped`、头 `rounded`、衣服 `farmer`，管家的长相（`look.orchestrator`，`OrchestratorLookValues`，画成 `manager-<长相>`）`farmer`，帮工的去掉；动物按 id 的 hash（每个码点取第一个 UTF-16 单元，`h*31+u`，32 位回绕）对 `speciesValues` 取模。页面 `ui/cast.ts` 的 `castOf` 用同一个 hash，所以没存长相的档案补上以后画面不变；接口给出去的必填枚举不会是空字符串。
- **帮工头像右下角标出运行工具**：档案读 `Agent.runtime`，执行读 `Session.runtime`；现成的像素 logo 放在头像外框上，悬停和辅助阅读给出农机清单里的全名。没有专用 logo 用扳手图标，不按档案 id 猜农机；主人、管家和导航的示意头像不加帮工的标识。
- **农场认的农机是 `runtimeIds` 的十个**：`claude`、`codex`、`opencode`、`vibevalley`、`pi`、`cursor`、`grok`、`kimi`、`antigravity`、`dsh`；`runtime.list` 照这个顺序给，农具页和捏帮工的农机列表也照它列。每台都有一份 `runtimePresets`，顺序一样。注册表（`registryOf`）是 oar 的内置农机（`defaultRuntimes`）加 VibeValley 自己的 agent（`runtime/vibevalley.ts`，每次开会话现取 DeepSeek 的钥匙；自己的任务存在农场的库里）加 DeepSeek Harness（`dsh`）。注册表里没有的报「不支持」：cursor 写明要单独装它的 SDK（`@cursor/sdk`），其余写「oar 不认识这个 runtime」。不认识的 id，`runtime.refresh`、`runtime.setting.update` 回 404。
- **四种已接通的农机这样承载**：VibeValley 和 pi 在服务端进程里，claude 走命令行，codex 走 app-server。真实项目的验证范围见[其他农机的提案](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)。
- **农机接受什么**（`RuntimeFacts`）：`steer`（干活时能不能插话）、`refused`（不接受的开会话选项：`systemPrompt`、`appendSystemPrompt`、`effort`、`env`、`mcpServers`、`disallowedTools`，带原因）、`capabilities`（`RuntimeCapability`：oar 的适配器能问它什么，农具页照它列）、`inProcess`。探测时 `refusals` 先取适配器自己的 `refusedSessionOptions`，再用 `seeds.json` 的 `runtimeFacts` 盖上去（农场的说法更严时以它为准），结果和种子的其余几项一起放在 `RuntimeInfo.facts`；`agentProblems` 优先用探测到的这份，没探测到才用种子。页面只读 `info.facts`，目录里没有的农机什么都不接受。
- **农机的样子**（`RuntimeInfo`）：名字、介绍和长相（`preset`，种子里没有的取 `fallbackPreset`、名字是 id）、接受什么（`facts`）、安装（`available` 带经由 `executable` 或 `bundled`、命令、版本；`not_found`；`unsupported` 带原因；`checking` 是服务端刚起来、还没探到；`runtime.list` 遇到还没探过的农机，在服务自己的纤程里探一次，探失败不留缓存、下一次列表再探，服务停了不再写缓存）、模型（去掉 `disabled` 的，带思考强度的档和默认）、额度、清单（技能、MCP、工具）、设置、今天的花费、额度的字（`quota`）、为什么现在不派（`stop`）、检测时间。读不到的模型和清单是 `null`，不是空列表。每次给出去前现算今天的花费、`stop` 和 `quota`。没装、不支持的农机也在 `runtime.list` 里，带着 `preset` 和 `facts`。
- **一份缓存，新的读不被旧的盖掉**：每台农机每次完整探测开始时取下一个号，开始得早的完整探测晚到了就丢掉。只读额度的更新不占完整探测的号，返回时只有开始时的 `Observation` 仍是当前缓存才合并额度和检测时间；完整探测已经换掉、另一份额度更新已落地或服务已关时丢弃旧结果。缓存里同时存着这次接受的安装（`found`），之后读额度、`resolve` 都用它。
- **清单在工作目录 `projects/` 下读**（`projectsDir`）：农机自己装的技能、MCP 服务器、工具，各最多等 10 秒，读不到或不是 `ok` 就是 `null`。MCP 的说明拼成「状态 · N 个工具」；技能和工具的来源取路径、MCP 的 id，没有就取 `source`。
- **这台电脑上装的技能**：页面把各农机清单里的技能按名字合成一份（`installedSkills`：第一个非空的说明，加上每台带着它的农机和来源，按名字排），只读；用这些农机的帮工自己按需加载。VibeValley 不复制它们。
- **技能库**是 Agent Skills 的形状（`id`、名字、description、正文）。档案勾上的，派活时按勾的顺序以「## 名字」加正文接在人设后面，不管用哪台农机；人设交给农机的三种方式见[帮工](docs/subsystems/session.md)。
- **预检和开会话用同一份选项规则**（`runtime/rules.ts` 的 `sessionOptions`）：先合并农机默认值与档案覆盖，再定模型回退，并检查农机能力与模型档位。`agentProblems` 把这些问题连同派新活的条件给预检；每次开会话的 `resolve` 也检查当次有效选项，有错就拒绝，不依赖较早的预检结果。设置存好就参与预检和解析，不等新探测完成。派活前（`issue` 的 `hire` 经 `check`，管家、计划、`dispatch` 挑人经 `assess`）和页面（`agent.validate`）跑同一个检查。`error` 让它派不出去，`warn` 只提醒，每条带出问题的字段：
  - `runtime`：不认识的农机；这台机器上找不到；在农具页被停用；以及钱的一条（`moneyStop`：额度用完、余额用完、到了每日预算，[帮工](docs/subsystems/session.md)）。
  - `persona`：写了人设、方式是追加或替换、农机不接受这个选项，原因后面加「把人设改成「写进工单开头」。」。
  - `effort`、`env`、`mcpServers`、`disallowedTools`：填了而农机不接受。
  - `model`：模型列表里没有档案所填或农机设置默认的模型（`warn`）。
  - `effort`：有效模型有档位、没有有效思考强度这一档（`error`，列出可选的）；模型回退时，按农机自己报的默认模型查。农机拒绝的思考强度、环境变量，从设置继承的也拒绝。
  - 档案停用（`enabled` 为假）不在 `agentProblems` 里：`Assess().Usable()` 和 `hire` 另查。
- **启停和钱只挡派新活**：`resolve` 不重查档案、农机是否启用或派活预算，已有 Session 叫醒时仍可解析有效配置；每次重新打开 oar 会话都检查选项是否受支持。
- **命令路径是探测的输入**：农机设置的 `binPath` 作为 `oar.InstallationOptions.Binary` 交给探测，不改服务端进程的环境变量；留空时按 PATH 和农机的默认候选找，填了但不存在就是没找到，不退回别的。独立的 `oar` 命令行没给路径时仍认 `OAR_<RUNTIME>_BIN`。

## 内置的模板

`apps/server/src/agent/templates/` 里，照 `index.json` 的次序：默认管家（`orchestrator`），和这些帮工：

| 档案 | 农机 | 动物 | 职责 |
|---|---|---|---|
| 后端老周 | pi | 熊 | 写接口、改 server、跑 Go 测试 |
| 测试小吴 | pi | 兔子 | 跑测试、修测试、盯 CI |
| 前端阿郑 | pi | 小狐狸 | 页面、3D 场景、交互动画 |
| 文档员 Kimi | pi | 猫 | 通读文档、写 README、整理说明 |
| 情报 Grok | pi | 猫头鹰 | 查资料、读外部文档、调研方案 |
| 夜班反重力 | pi | 浣熊 | 杂活、小改动、夜里补班 |
| Claude 师傅 | claude | 熊 | 读大代码库、重构、查难缠的 bug |
| Codex 老匠 | codex | 小狐狸 | 照工单把功能做出来，改到测试通过 |
| Pi 实验员 | pi | 刺猬 | 写原型、试新做法 |

## 怎么走

**探测一台农机**（`probe`）：

1. 读它的设置；注册表里没有就记成「不支持」，到此为止。
2. 带着命令路径问适配器的 `Installation`（最多 10 秒）；不是 `available` 就记成没找到或不支持，到此为止。
3. 同时读模型列表、额度（pi 读 DeepSeek 余额，别的问适配器的 `AccountUsage`，规则见[帮工](docs/subsystems/session.md)）、技能、MCP、工具，各最多 10 秒，出错的那一项留空。
4. 合上拒绝的选项和今天的花费，按读的号决定收不收进缓存；收了就经 `core.Runtime` 推给页面。

**什么时候读**：

- 开机后在后台把十台各探一遍（最多 4 台同时），第一次打开页面不等它；之后每 5 分钟只重读额度，停用的、没装的、没探测过的不读（claude 读一次额度要调一次它的 API）。
- 一轮干完，`session` 调 `usageSoon`：20 秒后重读这台的额度，几轮共用一次。额度没变就不推。
- `runtime.list` 马上答：有缓存给缓存，还没探到的给 `checking`（已带名字、长相和接受什么），探完经 `LiveEventRuntime` 推过来替换；服务端开机就在后台探全部（最多 4 台同时），没人开始探的那台由 `runtime.list` 在后台开始。页面上写「检测中…」，不等探测。`runtime.refresh` 总是重探（农具页的「重新检测」）。
- `runtime.setting.update` 先存设置，存不成就回错、不探；存成了重探一次，回新的样子。
- 花了钱（`spend`）以后 3 秒把这台的样子再推一次，期间花的一起带上。

**页面问能不能派**（`agent.validate`）：页面把一组档案（可以是没存的草稿）交给服务端，服务端对每个用缓存里农机的样子跑 `agentProblems`，按 id 回。捏帮工页底部、帮工列表、工单详情都读它（`useAgentProblems`），档案一变就重问；服务端答之前当作没有问题。

**派活时定农机怎么开**（`resolve`，`session` 开会话前调）：

1. 适配器不在注册表里回「oar 驱动不了 <农机>」；当次有效选项不受支持或模型没有所选思考强度，回拒绝，不开会话。
2. 模型：档案的，没写取农机设置的默认；农机报了模型列表而里面没有它，就用农机自己的默认模型，并在农场发一条提醒「<农机> 没有 <模型> 这个模型，<档案> 先用默认模型」。
3. 思考强度：档案的，没写取农机设置的默认。
4. 环境变量：农机设置的在前，档案的同名盖过它。
5. 安装：缓存里那次探测用的命令路径和现在的一样，就带上那次接受的安装（复制一份），`spawn` 直接用，不再探；不一样就只给路径，由 oar 当场找。

**新建和保存**：页面对没有 id 的草稿调 `agent.create`、有 id 的调 `agent.update`，之后重读档案和技能库。档案和技能库（`agent.list`、`skill.list`）、农机（`runtime.list`）分开读：农机探测失败只让农具那一块读不到，档案和技能照样能读、能改；每块读不到都在页面上说原因、能重试。服务端推来的农机样子盖掉列表里同一台。

## 和谁打交道

- **帮工（`session`）**：开会话前 `resolve`；拼说明时读 `Skills()`、档案（`Agent`）；同时干活的上限读农机设置的 `maxWorking`（`Config`）；记花费 `quote`、`spend`，一轮结束 `usageSoon`。
- **工单（`issue`）**：`hire` 读档案、跑 `check`，有 `error` 就回「<档案> 派不出去：<原因>」；档案停用另回「<档案> 被停用了」。
- **管家（`orchestrator`）、工具（`tool`）、计划（`task`）**：`Runtimes.candidates` 是每个档案和它现在能不能派（`assess`），`Runtimes.choose` 在其中按 `runtime/rules.ts` 的 `chooseAgent` 挑一个；管家、起草和计划都问它，不各自拼候选；管家把它们写进现状。
- **记性（`memory`）**、**定时任务（`cron`）**：`Agents` 列档案（不填档案的检索、定时任务派给谁）。
- **设置（`setting`）**：注册表里 VibeValley 自己的农机每次开会话取 DeepSeek 的钥匙。
- **核心状态（`core`）**：`Core.runtime` 推农机的样子，`Core.notice` 发模型退回默认的提醒；档案和农机都不进 `WorkspaceState`。
- **oar（`@botiverse/oar`）**：适配器的安装、`listModels`、账户用量、清单（技能、MCP、工具）、`refusedSessionOptions`。
- **处理函数（`handlers.ts`）**：`agent.*`、`skill.*`、`runtime.*` 只转发；`agent.validate` 逐个调 `Runtimes.problemsOf`。

## 为什么这样

- **派活派档案，不派农机。** 同一台农机配不同的人设、模型、技能是不同的帮工；一个档案同时派出好几个帮工，每个帮工按档案的 `worktree` 设置在项目目录或工单的 worktree 里干活。
- **档案存在一个 JSON 文件，不进表。** 只有几十份、整份读写、没有查询；主人能直接看、能备份。没有迁移：形状变了照「不留兼容」，旧文件作废。
- **事务给回调一份独立的副本，写盘成功才发布。** 放弃了每个回调各自记着复制（嵌套的环境变量、MCP 参数、预算指针会漏），也放弃了直接改当前版本、失败再读文件恢复（别的引用可能已经看到了改动）。
- **读不了的配置改名留着，不重新起一份盖掉。** 写过去，主人捏的档案就没了；宁可不开机。
- **档案从模板装，不在开机时整批灌。** 原来九个帮工写在 `seeds.json` 里，第一次开机全装：这台机器上没装的农机也照样装，删了的没处再装，种子改好了老农场拿不到，人设这些内容也跟着代码一起改。现在模板是文件夹里的数据，主人挑着装，装几份都行，模板出了新版本档案页提示，点了才盖。放弃了只把种子挪成文件、开机照旧全装（主人还是没得选）；放弃了带 frontmatter 的 `AGENT.md`（配置和人设混在一处，要另写一套 YAML 的校验），定了 JSON 加 Markdown；放弃了装好的档案跟着模板自动更新（主人改过的人设会被悄悄盖掉）；放弃了管家和帮工两套模板（角色本来就是档案的一个字段）。
- **新建的 id 由服务端在提交时分。** 页面自己挑 `agent-N`，两台设备（「连接到本机」那头的也算）同时建会互相覆盖；导入和编辑指定 id 仍走保存。
- **外观在服务端补齐，算法和页面一样。** 必填的枚举不能以空字符串到页面；补的和页面原来画的是同一只，存一次不换脸。
- **只给真实数据：清单从农机读，装了的技能不复制进技能库。** 两份会对不上，农机那边改了、删了，VibeValley 不知道；所以只读地列出来，帮工按需自己加载。示例技能也不预置：示例和真装的混在一页，主人分不清哪些真在起作用。连不上服务端时说什么见[客户端](docs/subsystems/app.md)。
- **「派不出去」只有服务端一份，页面问 `agent.validate`。** 页面里再写一份，页面说能派、派的时候被拒；草稿也能问，不用先存。
- **农机拒绝的选项以探测到的适配器为准，农场的说法盖在上面。** 只抄 `seeds.json` 会和 oar 漂开；只用适配器的，农场要更严、要中文原因时没有地方写。页面不从种子的标签推断能不能用。
- **`runtime.list` 不等探测。** 探一台要问命令行、读模型和额度，冷启动时全部探完要十秒左右；列表等它，农具页和捏帮工就空着。没探到的先给 `checking`，名字和能力已经在里面，探完靠侧事件替换。放弃了「页面自带名字先画」：那是种子的副本，见下一条。
- **农机的名字、长相和能做什么挂在 `runtime.list` 上，页面不读种子。** 「连接到本机」的设备和那台电脑的服务端版本不一样时，页面自带的名字和能力会和服务端说的对不上。放弃了另加一个接口把种子整份给（种子成了单独的东西，页面拿到还要自己拼）。挂在页面本来就在等的目录上，拿到的就是要显示的；目录到之前列表是空的，新帮工等目录到了再起草（名字和人设的方式都看农机）。
- **农机的样子不进核心状态，走窄事件流。** 它是从机器读来的观察，不是农场的事实；变得频繁（额度、花费），放进核心状态每次都要整份写盘、推全帧。
- **安装是显式的输入，不经进程环境变量。** 两份配置共用一个进程时，写 `OAR_<RUNTIME>_BIN` 会互相覆盖；`resolve` 带回探测时接受的安装，派活时不再探一次，指定的路径失效也不会悄悄换一台。
- **升级不在农场里做。** 升级改的是这台机器上的程序，可能打断正在干活的帮工；交给它自己的命令。

## 还没做的

- 从 git 地址装模板、模板带技能和 MCP。
- opencode、grok、kimi、antigravity、cursor 逐个跑通，各给一个内置模板：[pi 打磨好之后接回其他 runtime](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)。
- 档案加工具集（`toolsets`），管家和帮工按档案放行；技能书改成 Agent Skills 的文件夹，只把目录交给 agent，正文按需读：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。

## 怎么验证

- `apps/server/src/agent/template.test.ts`：内置的每个文件夹都在 `index.json` 里、各读得通，第一个是默认管家，英文的是英文。
- `apps/server/src/agent/agent.test.ts`：新农场只有默认管家和配置列的模板；一个模板装好几份，照模板更新只在叫它时做、留着这台机器的；本机的文件夹加进来、装上、删掉，读不通的说哪一栏；读不了的 `config.json` 挪到一边、像新农场一样开始；挪不开就不开机、不碰它；没有动物的档案补上页面画的那只；管家是有角色的档案：好几个管家各只在 VibeValley 自己的农机上，默认的删不了、改不成帮工，派活只派帮工；新建的 id 各不相同、带 id 的草稿被拒；给出去的是副本。
- `runtime/runtime.test.ts`：接受的探测拥有读用量的安装、慢的不覆盖新的；完整探测和额度更新交错时，两种完成顺序都保留新完整探测；适配器的拒绝挡住档案和继承的选项、农场的说法盖在上面；有效思考强度按实际模型或回退模型检查；设置已存而探测未完成时预检和解析一致；预检通过后改成不兼容设置，开会话仍拒绝；已有 Session 的解析不重套启停与预算；列表带每台农机的预设和事实；两份配置不经环境变量互相影响；存不上的设置被拒、不探测；`resolve` 管默认、覆盖和模型的退回；价目。`runtime/rules.test.ts`：`agentProblems`、`moneyStop`、额度的字照黄金数据。
- `session/rules.test.ts`：挑档案（按名字、按农机、选定的、按适合的活）。
- 页面：`apps/web/test/agents.spec.ts`（捏一个帮工、改、停用、删；不存在的档案说清楚；整页的样子）、`runtime-avatars.spec.ts`（两种农机的头像角标、全名、辅助阅读、16 px 小头像、桌面和手机截图）、`runtimes.spec.ts`（照 oar 找到的列、存设置再改回去）、`settings.spec.ts`（VibeValley 自己的技能写、列、删）。
