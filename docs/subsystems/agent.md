# 档案、农机和技能书

- **档案（`Agent`）**：一份 agent 配置，含角色、名称、职责 `duty`、匹配词 `tags`、农机、模型、人设、技能、MCP、环境变量与外观（可从 `AgentTemplate` 安装或手工创建）。
- **农机（`Runtime`）**：本机安装的编码 agent 程序，由服务端经 oar 探测安装、模型、额度与支持项。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 档案、技能库（`Skill`）与农机设置的持久化（`config.json`）及原子更新事务 | 助手如何使用档案（[助手](docs/subsystems/orchestrator.md)）、`vibevalley` 农机内部实现（[VibeValley 自己的 agent](docs/subsystems/brain.md)） |
| 档案模板的读取、安装、按模板更新与本地模板导入（`agent-templates/<id>/`） | 会话如何启动与并发上限（[帮工](docs/subsystems/session.md)） |
| 农机注册表、后台探测、模型与能力缓存、派活前配置解析（`Agent.resolve`） | 档案记忆的存储与召回（[记性](docs/subsystems/memory.md)） |
| 档案可派性预检（`agentProblems`：农机缺失、选项不兼容、额度/预算耗尽） | 像素角色贴图渲染（[农场的皮](docs/subsystems/farm.md)） |
| 每日花费 | 对话怎么拼提示、怎么压缩（[VibeValley 自己的 agent](docs/subsystems/brain.md)） |
农机详情区分缺少可执行文件、首次需要登录和账户用量报告登录失效。找不到文件时可填写命令路径。登录入口打开本机终端，用户自行登录后可重新检测。探测出错时展示失败原因。[农机详情](apps/mac/ui/features/runtime/RuntimesPage.tsx)


## 在哪

| 位置 | 职责 |
|---|---|
| `crates/vibevalley-server/src/modules/team/agent/mod.rs` | `agent.*`、`skill.*`、`runtime.*` 端点；`Agents` 把档案和农机拼成一扇门 |
| `crates/vibevalley-server/src/modules/team/agent/profile.rs` | 档案、技能与农机设置（`<家目录>/config.json`）、模板的读取、安装与更新（内置的和 `<家目录>/agent-templates/`） |
| `crates/vibevalley-server/src/modules/team/agent/runtime.rs` | 农机：经 `vibevalley-oar` 的 `Registry` 探测安装、模型、额度，花费 |
| `crates/vibevalley-server/src/modules/team/agent/presets.rs` | 农机预设、可派性校验、挑档案、额度文案；预设在 `crates/vibevalley-server/assets/agent/presets.json` |
| `crates/vibevalley-server/src/modules/team/agent/drive.rs` | 工单板跑档案：把档案、农机、技能与记性变成开会话的参数 |
| `crates/vibevalley-server/assets/agent/templates/`、`crates/vibevalley-server/assets/agent/skills/` | 内置模板（顺序见 `templates/index.json`）与 VibeValley 自带的技能，编进二进制 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`agent.*`、`skill.*`、`runtime.*`）。农机在线上仍是自己的概念（`runtime.*` 接口），服务端只有档案模块一扇门。

## 模型和不变量

- **一个服务**：档案、技能、模板和农机共用 `config.json`，所以是一个模块（`profile.rs` 加 `runtime.rs`），不拆两扇门。
- **单一配置文件与副本事务**：档案、技能库和农机设置存于 `config.json`，在副本上修改，写盘成功后才替换内存里的（删除技能时同事务清理档案引用）。
- **损坏配置自动备份，绝不覆盖**：启动时若 `config.json` 损坏或不符合 Schema，改名为 `config.json.unreadable-<毫秒>` 保留并按新农场初始化；改名失败则拒绝开机。
- **角色固定为 `orchestrator` 与 `worker`**：默认助手 `orchestrator` 不可删除或改为帮工；所有助手档案必须用 `vibevalley` 农机，派工候选只含 `worker` 档案。
- **跨层统一用 `Actor` 表示说话和操作的人**：`kind` 固定为 `user`、`agent`、`system`，仅 `kind: "agent"` 携带 `role`（`orchestrator` 或 `worker`）与 `forUser`。
- **`duty` 供阅读，`tags` 供匹配**：`duty` 是一句话职责说明；`tags` 是关键词数组。
- **挑档案顺序（`presets.rs`）**：依次匹配：点名的档案名或 ID → 点名的农机上首个可用档案 → 用户界面选定的档案 → 工单文字命中 `Agent.tags` 最多的可用档案。建单和起草都用它。
- **自带的技能只读，按 id 引用**：技能列表先列自带的（`builtIn: true`），再列用户自己写的；`skill.update`、`skill.delete` 碰到自带的一律拒绝，新建技能不占它们的 id。档案只存技能的 id，所以 VibeValley 一更新，勾了它的档案都拿到新版本。模板在 `agent.json` 的 `skills` 里写自带技能的 id，安装时勾上；按模板更新时再勾上，用户另勾的留着。任何档案都能勾自带的技能。
- **从模板按需安装与更新**：新农场默认只装 `orchestrator` 及 `agent.starters` 指定的模板；用户在工作台一键采用时由服务端优先匹配本机已安装且启用的农机并按需调整 `personaMode`；`agent.template.update` 仅覆盖 `duty`、`tags`、人设和 `worktree`，保留用户改过的名称、外观、农机与模型（旧档案尚未带头像时顺带继承模板头像）。
- **外观确定性补齐**：缺省外观按档案 `id` 哈希取模补齐，前后端算法一致；通用角色头像位于 `assets/pixel/avatar-*.png` 并登记在 `sprites.json` 中，优先于动物头像显示在工作台列表与卡片中。
- **农机列表**：`vibevalley-oar` 默认注册 `claude`、`codex`、ACP 农机（`acp:gemini`、`grok`、`kimi`、`codebuddy`、`opencode`）、SDK 农机（`qwen`、`qoder`）、自研 `vibevalley` 与测试用 `scripted`；`pi` 仅在 `VIBEVALLEY_TEST_RUNTIMES=1` 沙箱下作为替身注册，`cursor` 与未注册驱动的农机显示为不支持。各驱动协议与用量归约见[帮工](docs/subsystems/session.md#一次农机执行怎样复核)。
- **预检与开会话共用同一套规则**：合并农机默认设置与档案覆盖后，统一检查农机安装、额度预算与选项兼容性；预检与派活调同一函数，唤醒已有 `Session` 时不重复检查启停与派活预算。
- **探测代数防倒退**：完整探测分配递增序号，慢返回的旧探测不覆盖新缓存；探测结果经 `/api/v1/live` 的 `Runtime` 窄事件推送，不进 `SpaceState`。

## 内置的模板

内置模板位于 `crates/vibevalley-server/assets/agent/templates/`（顺序见 `index.json`），含默认助手 `orchestrator` 与 13 个覆盖全流程的通用帮工角色模板（均配有风格标签 `style`、分类 `category`、`avatar-*` 像素头像及中英结构化人设）：

| 角色 ID | 档案名称 | 分类 | 能力/技能 | 职责（`duty`） |
|---|---|---|---|---|
| `orchestrator` | 全能助手 | 助手（`orchestration`） | 统筹派活 | 理解目标、拆解工单、统筹派活并汇总验收结果 |
| `fullstack` | 全栈工程师 | 研发工程（`engineering`） | — | 端到端交付前后端功能、接口契约与自动化测试 |
| `architect` | 系统架构师 | 研发工程（`engineering`） | — | 梳理模块边界、制定重构方案与排查深层疑难根因 |
| `frontend` | 前端工程师 | 研发工程（`engineering`） | — | 实现界面组件、交互状态、响应式布局与浅深双主题一致性 |
| `backend` | 后端工程师 | 研发工程（`engineering`） | — | 实现服务端接口、数据存储、状态机契约与稳定性测试 |
| `reviewer` | 代码审查员 | 研发工程（`engineering`） | `reviewer` | 只读审查分支或工单改动，按严重程度定位缺陷、边界与测试缺口 |
| `tester` | 测试工程师 | 研发工程（`engineering`） | — | 编写单元、集成与回归测试，排查失败根因并修复不稳定用例 |
| `designer` | UI/UX 设计师 | 产品与设计（`product`） | `artifacts` | 打磨视觉层级、设计令牌、界面一致性与交互细节稿 |
| `product` | 产品经理 | 产品与设计（`product`） | `artifacts` | 梳理用户痛点、定义功能范围、拆解工单与可测验收标准 |
| `scout` | 技术调研员 | 调研与内容（`research`） | — | 查阅源码、官方文档与社区实践，对比方案并给出有出处的结论 |
| `docs` | 技术文档师 | 调研与内容（`research`） | — | 编写与维护架构说明、README、开发指南及双语用户文档 |
| `pages` | 数据看板师 | 产品与设计（`product`） | `pages`、`artifacts` | 搭建交互式数据看板、调研报表与自包含轻量网页工具 |
| `slides` | 演示汇报师 | 产品与设计（`product`） | `slides` | 梳理叙事主线并制作结构化幻灯片套稿与演讲者备注 |
| `collector` | 素材收集员 | 调研与内容（`research`） | `collector` | 按用途检索配图与设计参考，核验授权来源并归档入素材库 |

## 怎么走

**后台探测农机（`probe`）**

1. 启动后在后台并发探测全部农机（最多 4 台并发）；`runtime.list` 立即返回缓存，未探完的返回 `checking`，探完经 `LiveEvent` 推送替换。
2. 按设置的 `binPath` 经 oar 找到程序；若可用，读取模型列表与额度。
3. 开机、每 5 分钟及每轮运行结束 20 秒后（`usageSoon`）刷新已启用农机的额度，低于 15%（`quotaLow`）标「快用完了」；花费变动后 3 秒内合并推送最新 `RuntimeInfo`。

**派活前解析配置（`drive.rs`）**

1. 校验目标农机可用且当次有效选项均受支持，否则拒绝启动。
2. 选取档案指定的模型（未填取农机默认；若不在农机模型列表中，回退至农机默认模型并发 `Notice` 提醒）。
3. 合并农机与档案环境变量（档案覆盖农机），交给工单板开会话。

## 和谁打交道

- **帮工（`modules/work/session`）**：经 `drive.rs` 的 `Drivers` 把档案变成农机与参数，读勾选的技能拼入提示。
- **助手与工具**：挑可派档案。
- **hub**：推农机的 `live` 事件，发模型回退提醒。

## 为什么这样

- **派活针对档案而非直接针对农机**：同一台农机配不同人设、模型、技能和 `worktree` 策略即构成不同工种，且同一档案可并发派出多个 `Session`。
- **模板按需安装，更新需用户确认**：不在首次开机强灌全部帮工，避免未装农机报错；更新模板只覆盖职责与人设，不覆盖用户的模型与环境设置。
- **本机已装技能只读展示，不复制进 `config.json`**：各农机自带技能由农机按需加载，避免双份副本失步。
- **VibeValley 自带的技能不复制进技能库**：复制进去就和 VibeValley 的新版本失步，用户改过的又分不清该不该覆盖；按 id 引用，跟着 VibeValley 走，想换做法就自己写一个。助手的 skill（`crates/vibevalley-server/assets/orchestrator/skills/`）是 VibeValley 自己的 agent 按需加载的另一条路，不在技能库里。
- **农机观察走 `/api/v1/live` 窄流，不进 `SpaceState`**：避免每次 token 花费变动都触发全局状态折叠与广播。

## 还没做的

- `opencode`、`grok`、`kimi`、`codebuddy`、`qwen`、`qoder` 的真实厂商 CLI 实机验证（计费、配额、插话、取消与跨版本恢复）：[持久执行与驱动验收](.agents/notes/proposed/architecture/2026-11-18-native-durable-execution.md)。
- 档案配置 `toolsets`，技能库改用 Agent Skills 文件夹按需加载：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。

## 怎么验证

- `crates/vibevalley-server/tests/agent.rs`：删技能清引用、损坏配置留着、外观补齐、角色约束、新农场的档案、模板安装与更新、自带技能只读、农机经 hub、额度刷新。
- `crates/vibevalley-server/src/modules/team/agent/presets.rs` 里的单元测试：预设、挑档案。
- `apps/mac/ui/app/scenarios.test.tsx`：档案、农机、仓库与工作台多密度虚拟时钟页面测试（`nsh/test`）。
