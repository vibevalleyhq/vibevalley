# 档案、农机和技能书

- **档案（`Agent`）**：一份 agent 配置，含角色、名称、职责 `duty`、匹配词 `tags`、农机、模型、人设、技能、MCP、环境变量与外观（可从 `AgentTemplate` 安装或手工创建）。
- **农机（`Runtime`）**：本机安装的编码 agent 程序，由服务端经 oar 探测安装、模型、额度与支持项。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 档案、技能库（`Skill`）与农机设置的持久化（`config.json`）及原子更新事务 | 助手如何使用档案（[助手](docs/subsystems/orchestrator.md)）、`vibevalley` 农机内部实现（[VibeValley 自己的 agent](docs/subsystems/brain.md)） |
| 档案模板的读取、安装、按模板更新与本地模板导入（`agent-templates/<id>/`） | 会话如何启动、并发上限与每日花费表持久化（[帮工](docs/subsystems/session.md)） |
| 农机注册表、后台探测、模型与能力缓存、派活前配置解析（`Runtime.resolve`） | 档案记忆的存储与召回（[记性](docs/subsystems/memory.md)） |
| 档案可派性预检（`agentProblems`：农机缺失、选项不兼容、额度/预算耗尽） | 像素角色贴图渲染（[农场的皮](docs/subsystems/farm.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/agent/agent.ts` | 读写 `$VIBEVALLEY_HOME/config.json`、副本事务 `change`、外观补齐 `withCast`、角色校验 `roleProblem` |
| `apps/server/src/agent/template.ts`、`templates/` | 内置模板与本机导入模板（`agent-templates/<id>/`）的读取、安装与更新 |
| `apps/server/src/agent/agent.ts`（`readBuiltInSkills`）、`skills/<id>/SKILL.md`（`SKILL.en.md` 是英文） | VibeValley 自带的技能：随服务端打包（`base/assets.ts` 的 `serverFiles`），开机读一次 |
| `apps/server/src/runtime/runtime.ts` | 农机注册表、探测缓存、额度轮询、`assess` 与 `resolve` |
| `apps/server/src/runtime/presets.ts`、`presets.json` | 农机预设、支持项 `supportOf`、可派性校验 `agentProblems` 与挑人算法 `chooseAgent` |
| `apps/server/src/runtime/quota.ts`、`price.ts`、`dsh.ts`、`pi.ts` | 额度文案、模型单价表、DeepSeek Harness 与 pi 配置读取 |
| `apps/web/src/features/agent/`、`features/runtime/` | 档案列表、模板目录、捏帮工页、助手档案页、农具页与技能书页 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`agent.*`、`skill.*`、`runtime.*`）。

## 模型和不变量

- **单一配置文件与副本事务**：档案、技能库和农机设置存于 `config.json`，经 `Agent.change` 在深拷贝副本上修改并写盘成功后才替换内存引用（删除技能时同事务清理档案引用）。
- **损坏配置自动备份，绝不覆盖**：启动时若 `config.json` 损坏或不符合 Schema，改名为 `config.json.unreadable-<毫秒>` 保留并按新农场初始化；改名失败则拒绝开机。
- **角色固定为 `orchestrator` 与 `worker`**：默认助手 `orchestrator` 不可删除或改为帮工；所有助手档案必须用 `vibevalley` 农机，派工候选只含 `worker` 档案。
- **角色只管职责，别的各问一处**：档案是农场里的一个人，`role` 只决定他能做什么（工具、权限、能不能派去改代码）。他怎么上班、在哪干活、话算谁说的，各由一处回答：当值（会话 id 就是档案 id、开机就在）问 `isOnDuty`，按活雇来的问 `isHired`（`session/roster.ts`）；在服务端进程里干活、由 `Session.host` 收消息的问 `Agent.isHosted`；交给当值的人的工单问 `assignedOnDuty`。今天这几处都由角色推出来，以后有不当值的助手或在进程里干活的帮工，只改这几处。话是谁说的（`ActorKind`）只有 `owner`、`agent`、`system`，agent 另带 `role`（消息的 `fromRole`、触发的 `actor.role`、服务端的 `Actor`）；库里存的说话的人和定时任务、记忆的作者都只记这三种。
- **`duty` 供阅读，`tags` 供匹配**：`duty` 是一句话职责说明；`tags` 是关键词数组，`chooseAgent` 按工单文字命中的关键词数挑选帮工档案。
- **自带的技能只读，按 id 引用**：`Agent.skills()` 先列自带的（`builtIn: true`），再列用户自己写的；`skill.update`、`skill.delete` 碰到自带的一律拒绝，新建技能不占它们的 id。档案只存技能的 id，所以 VibeValley 一更新，勾了它的档案都拿到新版本。模板在 `agent.json` 的 `skills` 里写自带技能的 id，安装时勾上；按模板更新时再勾上，用户另勾的留着。任何档案都能勾自带的技能。
- **从模板按需安装与更新**：新农场默认只装 `orchestrator` 及 `agent.starters` 指定的模板；`agent.template.update` 仅覆盖 `duty`、`tags`、人设和 `worktree`，保留用户改过的名称、外观、农机与模型。
- **外观确定性补齐（`withCast`）**：缺省外观按档案 `id` 哈希取模补齐，前后端 `castOf` 算法一致。
- **十台注册农机与能力合并（`RuntimeSupport`）**：固定顺序为 `claude`、`codex`、`opencode`、`vibevalley`、`pi`、`cursor`、`grok`、`kimi`、`antigravity`、`dsh`；`support` 合并 oar `refusedSessionOptions` 与 `presets.json` 限制。
- **预检与开会话共用同一套规则（`agentProblems`）**：合并农机默认设置与档案覆盖后，统一检查农机安装、额度预算与选项兼容性；预检与派活调同一函数，唤醒已有 `Session` 时不重复检查启停与派活预算。
- **探测代数防倒退**：完整探测分配递增序号，慢返回的旧探测不覆盖新缓存；探测结果经 `/api/v1/live` 的 `Runtime` 窄事件推送，不进 `SpaceState`。

## 内置的模板

内置模板位于 `apps/server/src/agent/templates/`（顺序见 `templates/index.json`），除默认助手 `orchestrator` 外含 13 个帮工模板；最后四个各勾着一个 VibeValley 自带的技能（`skills/<id>/`）：

| 档案名称 | 默认农机 | 动物外观 | 职责（`duty`） |
|---|---|---|---|
| 后端老周 | `pi` | 熊 | 写接口、改 server、跑 Go 测试 |
| 测试小吴 | `pi` | 兔子 | 跑测试、修测试、盯 CI |
| 前端阿郑 | `pi` | 小狐狸 | 页面、3D 场景、交互动画 |
| 文档员 Kimi | `pi` | 猫 | 通读文档、写 README、整理说明 |
| 情报 Grok | `pi` | 猫头鹰 | 查资料、读外部文档、调研方案 |
| 夜班反重力 | `pi` | 浣熊 | 杂活、小改动、夜里补班 |
| Claude 师傅 | `claude` | 熊 | 读大代码库、重构、查难缠的 bug |
| Codex 老匠 | `codex` | 小狐狸 | 照工单把功能做出来，改到测试通过 |
| Pi 实验员 | `pi` | 刺猬 | 写原型、试新做法 |
| 幻灯片阿秀 | `pi` | 小狐狸 | 把一段内容做成幻灯片（技能 `slides`） |
| 素材小陈 | `pi` | 兔子 | 去网上找图、找参考，放进素材库（技能 `collector`） |
| 报表老钱 | `pi` | 熊 | 一页式的报表、看板、调研页（技能 `pages`） |
| 审查老严 | `pi` | 浣熊 | 审一个分支或一张工单的改动，只读不改（技能 `reviewer`） |

## 怎么走

**后台探测农机（`probe`）**

1. 启动后在后台并发探测全部农机（最多 4 台并发）；`runtime.list` 立即返回缓存，未探完的返回 `checking`，探完经 `LiveEvent` 推送替换。
2. 传入设置的 `binPath` 调用 oar `Installation`；若可用，并发读取模型列表、额度/余额、已装技能、MCP 与工具清单（每项限时 10 秒）。
3. 每 5 分钟及每轮运行结束 20 秒后（`usageSoon`）刷新已启用农机的额度；花费变动后 3 秒内合并推送最新 `RuntimeInfo`。

**派活前解析配置（`Runtime.resolve`）**

1. 校验目标农机可用且当次有效选项均受支持，否则拒绝启动。
2. 选取档案指定的模型（未填取农机默认；若不在农机模型列表中，回退至农机默认模型并发 `Notice` 提醒）。
3. 合并农机与档案环境变量（档案覆盖农机），返回探测确认的安装句柄供 `Session` 直接 `spawn`。

## 和谁打交道

- **帮工与工单（`session`、`issue`）**：派活前调 `check` 与 `resolve`；`Session` 读取档案与勾选的 `Skill` 拼入提示，运行后调 `spend` 与 `usageSoon`。
- **助手（`orchestrator`）**：调用 `Runtime.candidates` 与 `Runtime.choose` 获取可派档案、额度与花费。
- **核心状态（`core`）**：经 `Core.runtime` 推农机窄事件，经 `Core.notice` 发模型回退提醒。

## 为什么这样

- **派活针对档案而非直接针对农机**：同一台农机配不同人设、模型、技能和 `worktree` 策略即构成不同工种，且同一档案可并发派出多个 `Session`。
- **模板按需安装，更新需用户确认**：不在首次开机强灌全部帮工，避免未装农机报错；更新模板只覆盖职责与人设，不覆盖用户的模型与环境设置。
- **本机已装技能只读展示，不复制进 `config.json`**：各农机自带技能由农机按需加载，避免双份副本失步。
- **VibeValley 自带的技能不复制进技能库**：复制进去就和 VibeValley 的新版本失步，用户改过的又分不清该不该覆盖；按 id 引用，跟着 VibeValley 走，想换做法就自己写一个。助手的 skill（`orchestrator/skills/`）是 VibeValley 自己的 agent 按需加载的另一条路，不在技能库里。
- **农机观察走 `/api/v1/live` 窄流，不进 `SpaceState`**：避免每次 token 花费变动都触发全局状态折叠与广播。

## 还没做的

- 启用并验证 opencode、grok、kimi、antigravity、cursor：[其他农机提案](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)。
- 档案配置 `toolsets`，技能库改用 Agent Skills 文件夹按需加载：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。

## 怎么验证

- `apps/server/src/agent/agent.test.ts`、`template.test.ts`：自带技能随服务端打包、有英文、只读、模板安装时勾上、勾了的进帮工的提示。
- `apps/server/src/agent/template.test.ts`、`agent.test.ts`：内置模板、副本事务、损坏配置保护、角色约束与外观补齐测试。
- `apps/server/src/runtime/runtime.test.ts`、`presets.test.ts`：探测代数、支持项合并、挑档案与 `resolve` 测试。
- `apps/web/test/agents.spec.ts`、`runtimes.spec.ts`、`runtime-avatars.spec.ts`：档案增删改、模板安装、农机设置与头像角标端到端测试。
