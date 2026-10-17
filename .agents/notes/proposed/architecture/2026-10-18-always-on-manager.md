# Agent Note: 对照 Grok Bot 的常驻 agent：管家还差什么

Status: proposed

## Problem

Lee Robinson 在斯坦福 CS146S 讲了 xAI 的 Grok Bot 怎么做成一个常驻、主动的 agent（2026-10-09，[讲稿和幻灯片](https://www.peterp.me/transcripts/how-grok-bot-works/)，37 张）。它和我们的管家是一类东西：一个主 agent 和主人说话、派活给 helper，被消息、定时、电话、做完的活叫醒。讲的架构大半我们已经有，但有几处我们和它明确相反，其中一处（提示的开头每秒都变）让管家每次请求都命不中缓存。

本篇是索引：逐张对照，分成已经一样的（不动）、有差距的（每项一个设计）、有意不同的（写明理由）；小的差距的设计写在本篇，大的各有一篇 Note。下文的「幻灯片 mm:ss」指讲稿里那一张的时间点。

## 状态

| # | 差距 | 幻灯片 | 状态 | 设计在哪 |
|---|---|---|---|---|
| 1 | 提示的开头每次都变，没人量缓存命中 | 27:46、29:51 | 做了（49eeeba、a908d45）：每次回答记 `llm/usage`，开头按段比哈希、变了发 `prefix_changed`；系统提示只在起来和压缩后拼，时间、农场现状（全文或变了的行）、记性的更新进最新那条输入 | [提示开头不变](../../implemented/architecture/2026-10-18-stable-prompt-prefix.md)「三段」「量出来」 |
| 2 | 有话才说（`SendToUser`、「有没有值得说的」） | 11:13、18:20 | 暂不做：叫醒了就在频道里说 | 本篇[第 2 节](#2-叫醒了就在频道里说) |
| 3 | 主人叫不停管家 | 17:19 | 待做 | 本篇[第 3 节](#3-主人叫停管家) |
| 4 | 不在场时压缩、压缩复用开头 | 31:31 | 做了（b7cbbe3）：一轮停下后超过 9.6 万、空闲 10 分钟、管家没有 10 分钟内的定时才压；摘要请求用同一个开头、不许调工具；留下最后 3 句话 | [提示开头不变](../../implemented/architecture/2026-10-18-stable-prompt-prefix.md)「不在场时压缩」 |
| 5 | 来源和指令分开；收获、新定时要主人点头 | 26:28、11:13 | 待做 | [分清话是谁说的](2026-10-18-source-is-not-instruction.md) |
| 6 | 一轮做到一半时重启，接着做 | 16:17 | 做了：开机时对话没做完、不到 30 分钟就接着那一轮，做到一半的工具补「不知道做没做成」；叫停的不接 | 本篇[第 6 节](#6-重启后接着做完那一轮) |
| 7 | 发消息不带唯一的键，重试会发两条 | 15:26 | 待做 | 本篇[第 7 节](#7-发消息带-sendkey) |
| 8 | 关于主人的事实所有 agent 共享 | 32:50 | 归记忆的提案 | [记忆都存在 SQLite](2026-10-18-memory-in-sqlite.md)、[记性有多个来源](2026-10-18-memory-providers.md) |
| 9 | 管家的错变成评测 | 36:05 | 待做 | [管家的错变成评测](2026-10-18-manager-evals.md) |
| 10 | 帮工的长汇报整段进管家的上下文 | 28:46 | 待做（本次核对新发现） | 本篇[第 10 节](#10-长汇报不整段进管家) |
| — | 主动找主人 | 00:49、11:13 | `cron` 和管家自己定回头看已做；`by` 等迁移 | 本篇[主动找主人：靠定时](#主动找主人靠定时) |

## 对照

### 已经一样的

| 幻灯片 | 它的做法 | 我们的 |
|---|---|---|
| 00:49、10:10 常驻 | 跑在服务端，崩了、关了电脑也在；没事时什么都不跑，闲着几乎不花钱 | 服务端在本机常开，管家的循环跑在服务端；没输入时不调模型；巡查不调模型（`internal/manager/patrol.go:27`） |
| 11:13 谁叫醒它 | 你、定时和 webhook、Slack、电话和会议、别的 agent、后台的活做完、定时的检查 | 田头和 @、工单串、微信飞书 QQ、电话、巡查、定时、计划走到下一步、帮工的汇报（`manager.go:207-210`） |
| 11:13 路由去重 | 路由丢掉重复的，挑对话 | 连接器按外部消息 id 去重（`internal/connector/connector.go:424-431`）；巡查每件事报一次，4 小时后还在才再报（`internal/manager/patrol_rules.go:30`）；投递按对话分组交给管家（`channel/deliver.go` 的 `kicked`）。主人在 app 里重发的那条不去重，见第 7 项 |
| 17:19 新消息的规矩 | 你在一对一里说的插队、打断当前这一轮；群聊、helper、定时排队；连着来的三句并成一轮 | 主人在田头说的 `Send`（插进这一轮），别的 `Later`（这一轮做完再给）（`manager.go:613-616`）；一次投递里的几条并成一条输入（`manager.go:645-650`）。停止键见第 3 项 |
| 23:30 一个主 agent，多个 helper | 主 agent 答小问题、把大活交给 helper，收一份短汇报；一份待办记着每个请求；能查 helper、给它带话、叫停 | 管家只派活（`dispatch`），帮工汇报进工单串；工单就是那份待办；`check`、`tell`、`stop`、`dismiss`（`internal/manager/tools.go:740-743`） |
| 14:06 为什么在服务端 | 瘦客户端、厚服务端；电脑和手机之间来回切；agent 的循环和 app 的代码分开 | 规则和状态只在 Go（`protocol`、`Core.Apply`），Flutter 只读折好的状态；经院门换到手机 |
| 15:05 什么都存在服务端 | 电脑随时能重建 | 会话、轨迹、工单、记性都在家目录和 `vibevalley.db`；worktree 坏了能重开 |
| 15:26 推给 app 的 | 只推「变了」，带序号，缺了从数据库重读 | 状态流推整帧（`StateFrame`），丢了一帧下一帧就补上，比它简单，不改 |
| 19:14 工具配专门的界面 | 登录表单、付款批准、邮件草稿 | 收成清单（看过改动再合）、计划板（看过再开工）就是这种界面 |
| 25:12、29:51 工具设计 | 轮与轮之间不增减工具，用不了就返回写明下一步的错；每个工具的描述和参数不超过 4000 字；存状态用专门的工具 | 管家的工具表在大脑建好时定下，之后不变（`pkg/agent/agent.go:168-170`）；派不出去返回原因和下一步（`tools.go` 的 `dispatch`）；最长的描述不到 500 字；`remember`、`plan_edit` 是专门的工具 |
| 26:28 密钥不给模型 | 密码进环境变量，不进对话 | DeepSeek 的钥匙每次请求经 `GetApiKey` 取（`manager.go:442`），不进提示 |
| 28:46 主上下文要小 | 重活给 helper、截图给 helper、旧消息压成摘要、旧记忆可检索、说明变成技能 | 帮工在自己的会话里干活，管家只拿汇报；压缩到摘要、原文进 `archive/` 可用 `search_archive` 找回；技能用 `load_skill` 按需读全文。长输出那一条不一样，见第 10 项 |
| 34:29 主 agent 要快 | 主 agent 调成几秒内回答，helper 调成能干几小时 | 管家默认用 `deepseek-flash`（`pkg/agent/config.go:17`），帮工用各家农机 |
| 42:04 新的积木 | 持久工作流、记忆和技能、触发和定时、连接器、文字和语音、评测和可观测 | 都有一版：工单和 Session、记性、定时、微信飞书 QQ、田头和语音、轨迹和花费；评测见第 9 项 |

### 有差距的

**1. 提示的开头每次都变（幻灯片 27:46、29:51）。** 系统提示每次请求重拼，里面有精确到秒的时间、每次重读的 `MEMORY.md`、农场现状；管家每次请求都从第一段起命不中。管家的用量没人记。家目录里唯一一份管家会话（TypeScript 时代退役的，8 次回答）命中率 16.5%。细节和代码位置见[提示开头不变](../../implemented/architecture/2026-10-18-stable-prompt-prefix.md)。

**2. 有话才说（幻灯片 18:20、11:13）。** 它的主 agent 只有一个对外说话的工具 `SendToUser`：模型平常的文字不给人看，没新东西就不说；路由后面有一步「有没有值得说的」。我们的管家每一轮说的字都进田头（`manager.go:528-562` 的 `grow`、`done`），说了空话就不发（`done` 只发非空的）。本项暂不做，见第 2 节。

**3. 主人叫不停管家（幻灯片 17:19）。** 它的停止键插队、直接停掉正在跑的一轮。我们能叫停帮工（`session.stop`），`pkg/agent` 也能停（`Agent.Stop`，`agent.go:437-445`），但接口里没有叫停管家的口子，界面上也没有。电话里插话也停不了它：电话那头断开只关掉自己的输出流（`manager.go:747-755`），新说的话 `Send` 进同一轮，正在跑的这一轮照样做完、照样在田头说。

**4. 不在场时压缩（幻灯片 31:31）。** 它在一大轮结束、提示超过 10 万 token 后，等大约 10 分钟（缓存还热）就压，复用同一个开头；后台的活马上要叫醒它就跳过；最后几句对主人说的原样保留；一轮太长也能在中途压。我们在请求前（`agent.go:175-180`）和一轮刚结束时（`agent.go:367`）估出超过 12 万 token 就压；摘要请求换了系统提示（`pkg/agent/compaction.go:88-96`），十几万 token 全价；刚结束就压，主人一分钟后接着问拿到的已经是摘要。

**5. 来源和指令要分开（幻灯片 26:28）。** 它把邮件和 webhook 来的字标成不可信；记忆当作信息，不当指令；不经你同意不替你给人发消息，新的定时要你点头。我们的连接器只认配对过的主人，引用的原文不进管家（核对时改正，见下）；可帮工的汇报、`check`、`read_chat`、`changes` 的结果里转述的网页和代码，和主人的话没有分开，`merge` 也不看是谁让合的；管家自己建的定时马上生效。

**6. 一轮做到一半时重启（幻灯片 16:17）。** 它用持久工作流（Temporal）：每一步都记下，换一台服务器从上一步接着做；步骤写成重复执行无害（幂等）。我们重启时正在干的那一轮记成「停在了半路」（`internal/session/runs.go:101-110`，[重启保住农场](../../implemented/architecture/2026-10-10-restart-keeps-the-farm.md)）；管家的会话从 `manager.jsonl` 读回来，但大脑要等下一条输入才建（`manager.go:408-451`），那一轮不会接着做。

**7. 发送不带唯一的键（幻灯片 15:26）。** 它的 app 先显示、本地存一个唯一 id 再发，服务端丢掉见过的 id，所以重试安全。我们的 `SayRequest`（`internal/protocol/shapes.go:1204-1209`）没有这样的键；农场的聊天窗发出去就清空输入框（`app/lib/farm/chat_window.dart:149-160`），失败了主人只能重打一遍，第一条要是其实到了，就是两条。

**8. 关于主人的事实所有 agent 共享（幻灯片 32:50）。** 它的记忆分四层：主人的画像（最多 100 条、4000 字，每次都在提示里，所有 agent 共享）、带日期的日志（最相关的 30 条进提示）、很快淡掉的笔记、其余靠检索工具；每轮之后有一遍把新事实加进来、替换旧的，只能删它看过的。我们的主人偏好只在管家的 `MEMORY.md`，帮工拿不到。

**9. 每天把错变成评测（幻灯片 36:05）。** 它的内循环：bot 做错一次，就变成一条评测，修 harness、提示或推理，过了评测再上线。我们的管家测试用 `FauxProvider`，测的是 harness，不是模型的决策；[先采样，再验收](2026-10-14-sample-then-verify.md)第 2 步说的是帮工改代码的故障，不是管家的错。

**10. 长输出不进主上下文（幻灯片 28:46，本次核对新发现）。** 它的规矩：长输出放进文件，上下文里只留路径。管家的 `check` 只给汇报的结尾 2000 字（`tools.go:576-582`），可帮工在频道和工单串里的话，不管多长，都整段进管家的输入：叫醒它的那批（`manager.go:653`）和附在输入后面的「这期间田头上的汇报」（`manager.go:378-384`）都用 `protocol.InboxLines`，不截（`internal/protocol/chat_rules.go:52-66`）。

### 核对时改正的事实

本篇第一版有几处和代码不符，按代码改正：

- 第 5 项原来说「引用、转发进来的内容（`Quoted`）也一起进管家」：`Quoted` 只是被引用那条的外部 id，用来找回在哪个对话（`connector.go:472`、`381-397`）；引用的原文不进来，微信只取文字项（`pkg/weixin/weixin.go:276-306`）。
- 第 1 项原来说「这期间田头上的汇报」跟着输入走、不存进对话：它拼在这条输入后面，一起存进 `manager.jsonl`（`manager.go:617-620`）。`manager.go:35-36` 注释里的 `farmNews` 消息在代码里没有。
- 第 3 项原来说「电话里插话本来就会停」：插话只关掉电话那头的输出流，那一轮不停（见上）。
- 第 4 项原来说只在请求前压：一轮结束时也压（`agent.go:367` 的 `settleFold`）。
- 重启后读回的 `managerInput` 认不出来：`Details` 存成 JSON，读回来是 `map[string]any`（`pkg/agent/messages.go:103-106`），`managerInputOf` 的类型断言（`internal/manager/input.go:22`）失败，重启后第一轮之前 `requestInput` 退回到 `fm.input`。第 6 节一起修。

### 有意不同的

| 幻灯片 | 它 | 我们为什么不同 |
|---|---|---|
| 12:19、22:36 agent 自己的电脑 | 每个用户一台 Firecracker 虚拟机，有桌面、浏览器、能点屏幕，闲了存盘睡下 | 我们是本机的工作台，帮工在项目的 worktree 里改代码；隔离靠 worktree 和「只在工作目录里开工」（[帮工是 oar 的子 agent](../../implemented/architecture/2026-10-10-helpers-as-oar-subagents.md)）。要用电脑的活交给会用电脑的农机 |
| 04:08、26:28 自动审核 | 另一个模型先审有风险的动作，拦下就请你批，15 秒没回算拒绝 | 帮工没有权限确认，是有意的：只在 worktree 里干，改动要主人在收成清单里看过才合。合进主分支这一步就是我们的审核；管家这边由代码挡（[分清话是谁说的](2026-10-18-source-is-not-instruction.md)第 3 节） |
| 18:20 `SendToUser`：想法不给人看、富消息、少一次模型调用 | 平常的字不显示；消息可以带文件、选项、密码输入框；调了 `SendToUser` 这一轮就结束，不用再调一次模型 | 第 2 节的决定：说的字就是回答。要主人拿主意的地方用对象自己的界面（收成清单、计划板、待批的定时），不另做选项消息 |
| 19:14 表情回应 | 有时一个表情就是最好的回答 | 不做：管家没有要回的就不说 |
| 19:59 工具按需加载 | 提示里只放工具名，要用时读全文 | 管家 21 个工具加 4 个自己的、每个描述不到 500 字，一起放进去的代价小；技能已经按需加载。工具涨到要占一大块上下文时再做 |
| 21:31 先试最便宜的 | 知道的、连接器、搜索、浏览器、桌面，最后才问你 | 管家不自己干活，只派；这条留给各家农机 |
| 29:51 部署改了工具描述 | 正在进行的对话收到一条说明，不换成新的描述 | 本机一个用户，换版本要重启服务端；换版本后第一次请求命不中一次，接受；[提示开头不变](../../implemented/architecture/2026-10-18-stable-prompt-prefix.md)的哈希只在同一个进程里比，这一次从那条用量的命中率看 |
| 29:51 打字时预热缓存 | 主人一打开对话、开始打字，服务端先把提示送一遍 | DeepSeek 的缓存在磁盘上，留得久；先量命中率，还低再做 |
| 34:29 为产品训模型 | 用 harness 的样子做 SFT、RL | 我们不训模型；对应的是第 9 项的评测 |

## Proposal

每项单独一个改动。大的几项的设计在各自的 Note 里，这里只写小的几项。

### 1. 提示的开头不变

见[提示开头不变](../../implemented/architecture/2026-10-18-stable-prompt-prefix.md)「三段」「量出来」：系统提示只放说明、环境（不带时间）、技能清单、记性的快照，在两次压缩之间一字不变；时间（到分）、农场现状（第一条带全文，之后只带变了的行）、记性的更新拼进最新那条输入；每次回答在轨迹里记一条 `llm/usage`，开头哪一段变了也记下。

### 2. 叫醒了就在频道里说

**决定**：不做 `say` 工具，不区分是谁叫醒的。管家被叫醒（主人、巡查、帮工汇报、计划、定时），说的字照现在的样子进它回话的频道（`grow`、`done`）；没什么可说就回空，空的不发。

**为什么**：

- 简单：一条输出的路。电话边想边念靠的就是管家的字一边长一边推给声网（`manager.go:528-544` 的 `grow` 推给 `caller`）；加一个 `say` 工具，就有两条说话的路、两套规矩，电话那条还得保留。
- 主人看得到管家在干什么：后台叫醒的那一轮在田头留一两句，比轨迹里藏着好找。Grok Bot 自己也把「什么时候说话」列为没解决的问题（幻灯片 40:21：「说多了是噪音，说少了不知道它在干什么」）。
- 噪音先靠提示管：巡查那一条已经写着「不值得就什么也别说」（`manager.go:66`），定时和计划那两条写着「做完说一两句」（`manager.go:65`、`67`）。

**什么时候重新考虑**（满足一条就重新提，在本篇改这一节）：

- 主人说田头里管家的话太多；或者轨迹里不是主人叫醒的那些轮，过半都说了话、主人却没有回。数据在轨迹里：第 5 项给每一轮记了来源（[分清话是谁说的](2026-10-18-source-is-not-instruction.md)第 1 节）。
- 管家的话被推到主人的手机上（连接器的发件箱）变成每次都响。
- 要做选项、表单这种富消息：那时说话本来就要经工具。

### 3. 主人叫停管家

- **接口**：`internal/protocol/api.go` 加

  ```go
  //vibevalley:route manager.stop POST /api/v1/manager/stop
  //vibevalley:can owner remote
  ManagerStop(ctx context.Context) error
  ```

  跑 `go run ./tool/shapegen`（Flutter 得到 `api.manager.stop`，命令行得到 `vibevalley manager stop`）。处理函数在 `internal/handler/api.go`：`func (a api) ManagerStop(context.Context) error { a.f.Manager.Stop(); return nil }`。
- **服务**：`internal/manager/manager.go` 加 `func (fm *manager) Stop()`：大脑还没建（`fm.brain == nil`）就什么也不做；否则 `brain.Stop()`（`pkg/agent/agent.go:437-445`：清空排着的输入，中止这一轮）。已经派出去的帮工不动。
- **停下以后**：`event` 收到 `EventAgentSettled` 时把 `e.Aborted` 传给 `settled(aborted bool)`（`manager.go:507-508`、`564-576`）：
  - `aborted` 为真时 `answered(protocol.OutcomeInterrupted)`，交给管家的工单的那一轮记成「被叫停了」，否则照旧 `OutcomeCompleted`；
  - 轨迹记一条 `run/error`「主人叫停了」；
  - 电话的输出流照旧在 `settled` 里关掉；田头里已经说出来的半句留着（`done` 收到被中止的那条消息时照常写成最终的）。
- **排着被清掉的输入**：巡查和计划的消息丢了不补（巡查 4 小时后还在会再报，计划的状态在计划板上）；交给管家的工单在 `fm.working` 里，随上面的 `answered` 记成被叫停。
- **界面**：`CoreState.Manager` 是 `thinking` 或 `speaking`（`shapes.go:177-183`）时，田头的输入框旁边出现停止键，用已有的贴图 `app/assets/pixel/button-stop.png`：工作台在 `app/lib/workbench/chat/chat_composer.dart`，农场在 `app/lib/farm/chat_window.dart`。点了调 `app/lib/game/commands.dart` 新加的 `stopManager()`（照 `commands.dart:57` 叫停帮工的写法）。
- **测试**：
  - `internal/manager`：`FauxProvider` 让管家调一个先派活、再等着的工具；`Stop()` 之后管家回到 `listening`，派出去的帮工还在干，交给管家的工单那一轮的 `outcome` 是 `interrupted`；空闲时 `Stop()` 什么也不发生。
  - `internal/handler`：路由表的测试会因为新方法没答上而编译失败，答上即可；`docs/reference/capabilities.md` 跟着重新生成。
  - Flutter：管家在 `thinking` 时停止键出现，点了发 `POST /api/v1/manager/stop`（`MockClient`）；`listening` 时不出现。

### 4. 空闲时压缩

见[提示开头不变](../../implemented/architecture/2026-10-18-stable-prompt-prefix.md)「不在场时压缩」：一轮停下后超过预算的八成，空闲 10 分钟再压；10 分钟内有输入、有管家的定时要到点就不压；摘要请求用同一个开头、同一份工具，加一条要摘要的消息；切点之后至少留管家最后 3 句话。

### 5. 分清来源：信息不是指令

见[分清话是谁说的](2026-10-18-source-is-not-instruction.md)：输入带来源；提示写明只有主人的话是指令；`merge` 在这一轮没有主人的话时不动手；记忆的开头写明是信息；管家在后台起的重复定时、直接派帮工的定时等主人点头，给自己的一次性跟进直接生效。

### 6. 重启后接着做完那一轮

- **读回来的输入认得出**：`managerInputOf`（`input.go:17-24`）在 `Details` 是 `map[string]any` 时，把它 `json.Marshal` 再 `json.Unmarshal` 进 `managerInput`。`managerInput` 加 `Issue string`（`json:"issue,omitempty"`），`onWork` 填上交给管家的工单 id。
- **`pkg/agent` 加 `func (a *Agent) Resume(maxAge time.Duration) bool`**：
  1. 看会话最后一条消息：
     - 是带工具调用的 `assistant`、后面缺了某些调用的结果（工具做到一半就断了）：给每个缺的调用补一条 `ToolResultMessage`，`IsError: true`，字是「服务端在这个工具做完之前重启了，不知道它做没做成：先查一下现状，再决定要不要再做一遍。」，写进会话文件，然后接着做；
     - 是 `toolResult`、`custom` 或 `user`（工具做完了、模型还没回，或者输入还没人回）：接着做；
     - 是 `assistant` 且没有待做的工具调用：返回 false。
  2. 最后一条比 `maxAge` 还旧，就不接：返回 false。
  3. 接着做就是 `a.run(a.Core.Continue)`：`agentcore.Agent.Continue` 在最后一条不是 `assistant` 时从这里接着跑（`pkg/agentcore/agent.go:290-311`）。
- **`pkg/agent` 加 `func SessionUnfinished(file string) bool`**：只读会话文件，不建大脑，按上面第 1 步判断。读的是整个文件按 `Replay` 读出来的最后一条，不是文件的最后一行：一轮停下时存下的压缩摘要是文件的最后一行，它后面没有消息，只看那一行会把做完的一轮当成没做完。
- **叫停的不接**：主人叫停时（`Stop`），最后一条是被叫停的回答或工具的「已停下」（`agentcore.STOPPED`），第 1 步都算做完了。可服务端正常关掉时，`Close` 取消那一轮，`agentcore` 照样造出这些消息，一样会写进文件，重启后就分不出是谁停的；所以 `Close` 之后造出的消息不写进对话文件，文件停在被打断的地方，和崩溃一样。
- **管家**：`OnStart`（`manager.go:195-212`）在订阅之后，`SessionUnfinished(manager.jsonl)` 为真、DeepSeek 的钥匙也有，就在后台 `brainOf()` 再 `Resume(30 * time.Minute)`。接着做的那一轮，`EventMessageStart` 不会再来（输入已经在对话里），所以 `Resume` 返回 true 之前，管家用 `requestInput()` 读回最后那条输入，设成 `fm.input`，回答发回原来的频道；它带着 `Issue` 时，往 `fm.working` 加一条 `managerRun{issue: Issue}`（`run` 为空：原来那一轮已经被开机记成停在半路，`CloseRun("")` 什么也不做，`runs.go:124-125`），这一轮停下时 `answered` 把工单关上。返回 false 时轨迹记一条 `run/error`「上一轮停在了半路，太久了，没有接着做」。
- **不会派两次活**：已经有结果的工具不重跑（结果在会话里）；做到一半的那个工具，模型拿到的是「不知道做没做成，先查一下」，它要先 `roster`、`check`、`list_schedules` 看过再决定。
- **帮工**：保持现在的「停在了半路」，有人带话再接；帮工的会话在各家农机里，我们只能接回会话，不能接着某一步。
- **测试**：
  - `pkg/agent`：会话文件分别以 `toolResult`、缺结果的工具调用、模型的回答、两小时前的 `toolResult` 结尾，`Resume` 分别接着跑（`FauxProvider` 收到一次请求，缺结果的那次请求里有补上的错误结果）、接着跑、不跑、不跑；`SessionUnfinished` 同样四种。
  - `internal/manager`：`FauxProvider` 让管家在 #clock-in 调 `dispatch`，工具结果写进会话后关掉服务；新开一个管家（同一个家目录），`OnStart` 后它接着那一轮、回答发在 #clock-in，地里只有一个帮工。
  - `internal/manager`：`managerInputOf` 读一条从 JSON 解出来的输入，频道和选定的帮工都对。

### 7. 发消息带 `sendKey`

- **形状**：`SayRequest`（`shapes.go:1204-1209`）加 `SendKey *string`（`json:"sendKey,omitzero"`）：客户端为一次发送生成的键，1–64 个字符；超长就拒绝，说「sendKey 太长」。跑 `go run ./tool/shapegen`。
- **表**：不用迁移。`channel_message` 已经有 `send_key` 列和 `(sender_id, send_key)` 上的唯一索引（`server/migrations/0001_schema.sql:31`、`220`），代码里一直没写过它。
- **查询**：`server/pkg/db/queries/channel_message.sql` 的 `InsertMessage`（第 3–7 行）加 `send_key` 参数；新加 `MessageBySendKey`：按发送者和 `send_key` 取一条。跑 sqlc。
- **写**：`chatWrite`（`internal/channel/deliver.go:18-28`）加 `sendKey string`；`write`（`deliver.go:199` 起）在新建消息之前、同一个事务里，`sendKey` 非空就先按它查，查到了就把那条当结果返回，标上 `chatWritten.again = true`，不插新的、不投递。`Say`（`internal/channel/chat.go:483`）加参数 `sendKey string`，`again` 时跳过 `readThrough`、`publishConversation` 和「不在地里」的提醒，直接返回原来那条。`Spoken`（`chat.go:663`）同样加 `sendKey`。
- **调用的地方**：`manager.Say`（`manager.go:694-706`）把键传下去，`again` 时不再记一次选定的帮工；`ChannelSay`、`ManagerHear`（`internal/handler/api.go:58-64`、`97-101`）传 `ptr.Value(body.SendKey)`；`Heard`（`manager.go:710`）把键传给 `Spoken`，`again` 时不再交给管家。连接器那条路已经按外部 id 去重，传空。
- **Flutter**：`Messages.send`（`app/lib/data/messages.dart:36-53`）加参数 `String sendKey`，键用 `Random.secure()` 生成 16 字节、十六进制（不加依赖）。工作台的输入框（`chat_composer.dart:39-57`）为一份草稿生成一个键，草稿没变就一直用它，发成功才换；农场的聊天窗（`chat_window.dart:149-160`）改成失败时把草稿放回输入框、键不变，重发用同一个键。种地发话（`app/lib/game/commands.dart:69`）、语音（`app/lib/voice/voice.dart:27`）每次一个新键。
- **测试**：
  - `internal/channel`：同一个键 `Say` 两次，对话里一条消息、管家只收到一次；不同的键两条；没有键两条。
  - `internal/manager`：同一个键经 `Say` 两次，`FauxProvider` 只收到一条输入。
  - Flutter：发送失败后草稿还在，再发时请求体里的 `sendKey` 和第一次一样（`MockClient`）。

### 8. 共享的主人画像

归[记忆都存在 SQLite](2026-10-18-memory-in-sqlite.md)（画像的表、上限、只在会话打开和压缩后取一次）和[记性有多个来源](2026-10-18-memory-providers.md)（`SystemPromptBlock`），本篇不另设计。两条和本篇有关的约束已经写在那里或本篇：画像在两次压缩之间不改系统提示（[提示开头不变](../../implemented/architecture/2026-10-18-stable-prompt-prefix.md)第 1 节的 `MemoryNews`）；画像的标题写明是信息、不是指令（[分清话是谁说的](2026-10-18-source-is-not-instruction.md)第 4 节）。

### 9. 管家的错变成评测

见[管家的错变成评测](2026-10-18-manager-evals.md)：主人在管家页标出做错的一轮，存成家目录里的样例；修的人写几条固定的判断，样例进仓库前先确认它抓得住录下的错；改提示前后用 `go test -tags evals` 拿真模型每个样例采 5 次。

### 10. 长汇报不整段进管家

- `internal/manager` 加纯函数 `managerInboxLines(messages []protocol.InboxMessage) string`：照 `protocol.MessageLine` 的格式，正文超过 `managerLineMax = 800` 个 UTF-16 单位（`str.Units`）时只留前 800（`str.Head`），后面接「…（这条有 N 字，全文用 read_chat 读 <target>）」，`<target>` 是这条消息所在的频道或串，照 `read_chat` 的写法（`#<频道>` 或 `#<频道>:<消息号>`）。
- `heardInChat`（`manager.go:653`）和 `news()`（`manager.go:383`）改用它。`read_chat`（`tools.go:604`）是管家自己要读的，照旧给全文，条数由 `chatReadLimit = 30` 管（`internal/channel/chat.go:31`）；`check` 照旧给结尾 2000 字。
- 规则只有管家一个主人，放在 `internal/manager`，不动 `protocol.InboxLines`（帮工经 MCP 读频道也用它）。
- **测试**：`managerInboxLines` 的表驱动测试（799、800、801 个字、带中文和表情）；帮工在工单串里 @管家 写了 5000 字，`FauxProvider` 收到的输入里只有前 800 字和那句指引。

### 主动找主人：靠定时

Grok Bot 的主动来自定时和后台的活（幻灯片 00:49、11:13）。我们的路是定时：定时已经有了 `cron` 种类（五段式表达式），管家会给自己定一次性的回头看，醒了就直接在频道里说（[定时加上 cron](../../implemented/feature/2026-10-18-cron-and-follow-ups.md)）。还差 `Schedule` 上的 `by`（`owner` 或 `manager`），要加一列，等排着的迁移进了主分支再加。和本篇的接口：

- 跟进到点叫醒管家，照第 2 节在频道里说。
- 哪些管家起的定时直接生效、哪些等主人点头，见[分清话是谁说的](2026-10-18-source-is-not-instruction.md)第 5 节，那一节等 `by` 上线后做。

### 步骤

1. 第 1 项的「量」（`llm/usage`）先做，记一周作基准。
2. 第 3、7 项：改动小，各自独立。
3. 第 1 项其余、第 4 项，按[提示开头不变](../../implemented/architecture/2026-10-18-stable-prompt-prefix.md)。
4. 第 5 项的第 1–4 节，和第 10 项一起（都是管家输入的字）；第 5 节等 `by`。
5. 第 6 项。
6. 第 9 项；第 8 项跟着记忆的两篇。

每项做完，把这张状态表的那一行改成「做了」并写上提交；全部做完、行为写进 `docs/` 以后，本篇挪到 `implemented/`。

## Alternatives considered

**照搬 `SendToUser`：管家所有的话都经工具说。** 和它最像，也能做到「后台叫醒时有话才说」。不做的理由见第 2 节：两条说话的路、电话那条还得留；噪音先靠提示管，有数据说明吵了再做。

**只在后台叫醒时用 `say` 工具，主人叫醒的那一轮照旧（本篇第一版的提案）。** 比全部经工具省事，可还是两条路、两套规矩，模型得记住哪一轮该用哪条；主人也会看不到管家在后台想过什么。被主人否了，见第 2 节。

**用 Temporal 这样的持久工作流引擎。** 管家的一轮已经一步一步写进 `manager.jsonl`，读回来就知道停在哪（第 6 节）；为一个本机的单用户服务再起一个工作流引擎，太重。

**给帮工加自动审核。** 帮工改的是 worktree，合进主分支要主人看过；再加一个模型审每条命令，多花钱、多一层等待，挡的又是收成清单已经挡住的。

**工具改成按需加载。** 现在 25 个工具、每个不到 500 字，按需加载省下的不多，还要多一次读工具的往返。

**发消息的去重放在内存里（最近 100 个键）。** 不用改查询，可重启后就忘了；`send_key` 列和唯一索引本来就在表里。

## Acceptance criteria

- 第 1、4、5、9 项照各自 Note 的验收。
- 管家在想时，田头里能停掉这一轮，已经派出的活照常，交给管家的工单那一轮记成被叫停。
- 管家调了工具、还没回答时服务端重启，开机后这一轮接着完成，回答发在原来的频道，没有重复派活；停了半小时以上的不接。
- 同一个 `sendKey` 发两次，田头里只有一条，管家只听到一次；农场聊天窗发送失败后草稿还在。
- 帮工 5000 字的汇报进管家时只有前 800 字和读全文的指引。
- 本篇的状态表和各 Note 一致；第 2 项的决定写在本篇，被重新考虑时改这一节。
- `go vet ./... && go test ./...`、`bun run go:deadcode`、`bun run flutter:check`、`bun run docs:verify` 通过。

## Risks

- 第 2 项不做，后台叫醒的轮可能在田头里留下没用的话；靠提示和第 2 节的重新考虑条件兜。
- 叫停清掉了排着的输入，巡查和计划的消息不补；主人叫停时就是想让它别说了，接受。
- 重启后接着做，前提是工具结果都已写进 `manager.jsonl`；工具做到一半就断的，模型拿到「不知道做没做成」，要靠它先查再做，查错了还是可能重复派活。
- 截断帮工的汇报后，管家可能漏掉后半段的要点；800 字够放一份汇报的结论，管家要细节用 `read_chat` 或 `check`。
- 第 1 项的收益只在一份 8 次回答的旧会话上量过，要改完再量。
