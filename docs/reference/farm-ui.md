# 界面清单

原生应用里有什么界面：工作台的页面（nsh 跑的 TSX，`apps/mac/ui/vv/web`）和 Rust 画的像素场景（`apps/mac/src/pixel`）。路由表在 `apps/mac/ui/vv/web/app/App.tsx`，导航栏的条目在 `apps/mac/ui/vv/web/app/places.ts`，以代码为准。概念映射、像素渲染和寻路见[农场的皮](docs/subsystems/farm.md)，窗口外壳见[客户端](docs/subsystems/app.md)，素材管线见 [开发](docs/development.md#素材音效和官网)。

画风采用型号 B「温室花园」（原图在 `vibevalley-art` 仓库，经 `design/art.sh` 链入）。像素字体为 Fusion Pixel 12px，字号仅用 12 与 24。

## 角色

- **助手（人）**：站在农舍门口；外观存在档案里。
- **帮工（小动物）**：7 种动物（熊、兔子、小狐狸、猫、猫头鹰、刺猬、浣熊）× 4 套衣服（农夫、园丁、雨衣、冬装），仅作外观区分，与农机无绑定关系。内置模板见[内置的模板](docs/subsystems/agent.md#内置的模板)。

## 像素场景

| 场景 | 从哪进 | 是什么 |
|---|---|---|
| 开场 | 打开应用 | 按本机时间选的场景图（5–10 点早晨、10–18 点白天、其余夜里）、品牌名、进度条和跟着阶段变脸的小精灵；项目读完后让开（[客户端](docs/subsystems/app.md#怎么走)） |
| 农场 | `/farm`、`/farm/<仓库>` | 一个仓库一座院子：9 块地、在场的帮工、院内建筑；数字键 1–6 换农具；点地块去它的工单，点空地去建工单，右键点有帮工的地块在它的 worktree 开终端（[农场的皮](docs/subsystems/farm.md#模型和不变量)） |
| 地图 | 农场里的「地图」 | 每个仓库一座岛，岛上的地是在做的工单和空位（[截图](docs/images/map.png)） |
| 记忆树 | `/tree` | 一棵跟着干活的轮数长大的树，记性挂在上面 |
| 图鉴 | `/catalog` | 贴图按书架排，底色可换（格子、草地、夜里）；指针和音效两个书架在工作台的图鉴页里 |

## 工作台的页面

**外壳**（`apps/mac/ui/vv/web/app/Shell.tsx`）：最左为安静的导航栏，条目按组排（每天干活的、配置的、查阅的）。

| 页面 | 路由 | 内容 |
|---|---|---|
| 聊天 | `/chat` | 频道分组、私聊、消息与串；频道头部可查看串、置顶与成员（频道里的助手和在场帮工） |
| 工单看板 | `/issues` | 分待办、处理中、等你看、已关四列，支持流转与排序（满地标「排队中」）；点待办列头的「新工单」填一句话并选仓库与帮工，生成「草稿」卡片由帮工起草；父工单显示子单完成数；派给助手的工单完成后在详情点「知道了」或「关上」 |
| 工单详情 | `/issues/<id>` | 见下面「工单详情」 |
| 素材库 | `/library` | [媒体和素材库](docs/subsystems/media.md) |
| Artifact | `/artifacts`、`/present` | [Artifact](docs/subsystems/artifact.md)；`/present` 是演讲者视图 |
| 笔记 | `/pkm` | [笔记](docs/subsystems/pkm.md) |
| 档案 | `/agents`、`/agents/<id>` | 上方为助手卡片，下方为帮工卡片；可从模板装（预览人设、安装、导入本机模板目录或按新版本更新档案）。助手档案页编辑名字、职责、人设、模型和外观；帮工档案页选动物与衣服，填身份、能力、人设、技能、工具和环境，底部实时显示 `agentProblems`（[档案和农机](docs/subsystems/agent.md)） |
| 助手 | `/orchestrator`、`/orchestrator/<档案 id>` | [助手](docs/subsystems/orchestrator.md) 的记性和轨迹 |
| 农机 | `/runtimes` | 每台农机：探测结果、额度、能力、模型、自带技能和 MCP、工具清单及关联档案；可配置开关、命令路径、默认模型和思考强度、环境变量、并发上限与每日预算（存在 `config.json`） |
| 仓库 | `/repos` | 仓库列表；选中的仓库看它的地块、空位、排队工单、代码概况、语言占比、一年提交日历与参与帮工；支持从 GitHub 克隆或新建空仓库（[仓库](docs/subsystems/repo.md)） |
| 图鉴 | `/catalog` | 图、指针、音效三个书架，分类浏览与搜索 |
| 设置 | `/settings/<分区>` | 左栏是搜索框与分组导航（分区见 `apps/mac/ui/vv/web/features/setting/SettingsPage.tsx`），右栏按卡片展示设置项，标明农场级或本机级生效范围 |
| 工作区 | `/workspace` | 外壳自己的项目：文件、终端、diff，不是 TSX 页面 |

### 工单详情

工单详情是独立页（`apps/mac/ui/vv/web/features/issue/views/IssueDetail.tsx`），读的是 `apps/mac/ui/vv/web/features/issue/model/overview.ts`（基于服务端 `Issue.stage`，[工单](docs/subsystems/issue.md)「给用户看的状态」）。从上到下：

- **这是什么**：`#号`、单行短标题（`shortTitle`）、仓库与优先级。
- **现在怎样**：当前阶段、等待或运行耗时、帮工、轮次与花费（卡住标红）。
- **要你做的**：仅在需用户操作时出现，只放一个主按钮（回答问题、验收通过、打回、恢复卡住、重开）。
- **做到哪了**：验收标准逐条自评与凭据（`N / M 条做到了`），待验收时可勾选。
- **做出了什么**：分支、提交数、增删行数与折叠的文件列表。
- **怎么走到这一步**：时间线（`issue.timeline.get`）与折叠的完整说明、执行步骤。
- **右栏**：次要动作（关单、叫停、带话）与元数据（时间、模型、分支、worktree）。

## 轨迹

助手页与帮工档案页共用 `apps/mac/ui/vv/web/features/session/Trajectory.tsx`（先读日志快照再合并直播事件）：

- **一步一行**：展示轮次、时间、彩色类型标签与内容摘要；工具行格式为 `做了什么 {参数} → 结果`（失败标红），点击展开全文与工具输入输出。
- **顶部瀑布条**：分收到、模型、工具三道按耗时排列（跳过轮间空闲），点击片段定位到对应行（计算规则见 `apps/mac/ui/vv/web/features/session/runs.ts`）。
- **底部合计与搜索**：汇总轮数、步数、模型与工具耗时及 token 用量（含缓存命中）；右上搜索框按标签、正文与工具输入输出过滤。

## 精力瓶与计分

- **精力瓶**（`apps/mac/ui/vv/web/features/runtime/quota.ts`）：液面反映最紧窗口的剩余额度，额度低时变色。
- **计分**：规则见[游戏](docs/subsystems/game.md#模型和不变量)，页面直接展示服务端计算的金币、等级与成就。
