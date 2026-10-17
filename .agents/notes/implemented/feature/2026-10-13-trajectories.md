# Agent Note: 每个帮工和管家都有一条轨迹，帮工走了也留着

Status: implemented

## Problem

主人要看 agent 到底干了什么，却看不全：
- **管家**跑在 VibeValley 自己的 agent 上时，每次工具调用其实都写进了 `manager.jsonl`，可服务端把工具事件直接丢了，没有接口，也没有页面。农场上只看到一个「在想」，田头上只看到它最后说的话。它看了谁的进度、给谁带了话、收了什么，界面上都看不到。
- **帮工**的干活过程只在农场的地块详情里能看。帮工一收工，文件就删了，接口返回 404。事后想知道某个帮工当时怎么改的、为什么失败，已经查不到了。

主人的要求是：每个子 agent（帮工）都得有轨迹，管家也要有。

## Decision

头文件和 `TrajectoryHead` 后来被 [Session、Run、事件](../../proposed/architecture/2026-10-17-session-run-step.md) 取代：是谁、怎么关的进了 `session` 表，走了的 Session 也是 `Session`（阶段 `closed`）；步骤是 `SessionEvent`，在 `events/<id>.json`。下面是当时的决定。

行为见 [server.md](../../../../docs/reference/server.md)「帮工」里的「轨迹」和 [agents-and-runtimes.md](../../../../docs/reference/agents-and-runtimes.md)「管家页」「捏帮工」。

- **轨迹就是干活过程加上它是谁的**。步骤还是 `Activity`（当时叫 `WorkStep`），一条轨迹一个 journal（`server/internal/session/events.go` 的 `crewJournal`）。另外多一个头（protocol 的 `TrajectoryHead`），记名字、帮工档案、农机、项目、工单、什么时候开始、什么时候结束。两样都放在 `$VIBEVALLEY_HOME/steps/`：`<id>.json` 和 `<id>.head.json`。
- **`Trajectories` 服务管轨迹从开始到删掉**（`internal/session/trajectories.go`）。`crew.go` 派活时 `Open`，帮工离开时 `Finish`。`Finish` 只是写完、关上、标上结束，不删文件。走了超过 `trajectory.days` 天（默认 30，0 是一直留着）的轨迹，服务端启动时删掉它的步骤；头留着，因为它就是一张工单（[工单](2026-10-14-tickets.md)），看板上的历史不该过一个月就消失。工具的输入和输出比只在地块详情里看时留得多（输入 4000 字，输出开头 2000、结尾 4000），事后翻看时能看出发生了什么。
- **管家的轨迹走同一条路**，id 是 `foreman`，不会结束，留最近 1000 步：
  - `foreman.go` 把交给它的每一句话记成「收到」。
  - 管家把工具开始、结束和它说的话记进去（`foreman.go`；工具的标签和思考由 `manager/tools.go` 的 `foremanToolStart`、`foremanThinkingOf` 读出来）。当初 TypeScript 服务端有两种管家（VibeValley 自己的 agent 和 pi），报工具事件的字段一样，共用一个 `manager-trace.ts`；Go 服务端只有 VibeValley 自己的 agent 这一种。
  - 步骤照样用 `step` 工地事件推给页面，页面不用为管家另写一套。
- **思考和帮手也在轨迹里**：
  - 农机交出来的思考记成 `thought` 一步。
  - 帮工派出去的子 agent 按 oar 的 `agentPath`（smith 里是 `AgentPath`，`session/facts.go` 读）认出来，步骤带上 `under`（派它出去的那次调用的步号），工具调用按「哪个 agent 的、哪一个」认（`session/events.go`）。
  - 这样每个子 agent 的轨迹都排在它的帮工的轨迹里，接在派它出去的那一步下面，不另开一条。
- **页面**：
  - 管家页的「轨迹」页签和帮工档案页的「轨迹」页签，都用农场地块详情那套干活过程的显示（`WorkLog`，`app/lib/shared/work_log.dart`）。
  - 帮工档案页列出这个档案派出去的每个帮工，点开就是那个帮工的轨迹。
  - 聊天页上，管家的消息和帮工的汇报下面挂着这一轮的步骤（`app/lib/game/state.dart` 的 `turnEndingAt`：往回找到开始这一轮的那句话）。
- **按轮看，能评论一步**：地块详情里的干活过程按轮排（每一轮从它收到的一句话起），每轮一条时间条。主人能在任何一步下面评论：`TellRequest.on` 是第几步，服务端把那一步是什么写进带给帮工的话里（「【评论第 N 步】」开头），记这句话的那一步从标记里读回 `WorkStep.on`，评论就挂在被评论的那一步下面，没做完的地方能接着做。

## Alternatives considered

**让页面直接读 `manager.jsonl`。** 那份文件更全，有思考，也没有步数上限，但它是对话的格式，不是步骤，页面得自己去配对工具调用和结果。管家跑在 pi 上时，会话又是 pi 自己的格式。改成从事件记步骤，两种管家写出来的一样，和帮工的显示也一样。`manager.jsonl` 还在，要查最全的可以去翻。

**轨迹存进数据库。** 能按条件查，但干活过程本来就是 journal 写的文件，带着推送和分批写盘。整条轨迹的读写都是一次一整条，用不上查询，所以只在旁边加一个头文件。

**帮工走了以后永远不删。** 最省事，可一天派几十个帮工，每个一份工具输出，会一直涨。按时间删，主人最常回头看的这一个月都在。

**子 agent 各开一条轨迹。** 列表更整齐，但子 agent 是帮工干活的一部分，拆开以后要来回对照才看得出它为什么被派出去。挂在派它的那一步下面，读起来是连着的。VibeValley 自己的 agent 用 `spawn_agent` 派的帮手不把事件交给宿主，现在只留下那一步和交回来的结果，要记进来得先改 VibeValley 自己的 agent（`server/pkg/agent`）。

**忽略 `agentPath`，照旧按调用编号认。** 这是以前的做法：子 agent 的工具调用和话混在帮工自己的步骤里，编号相同的两次调用还会互相盖掉结果。oar 自己也说只看调用编号不能当全局的键。

**评论的步号单独走一条路，从带话一直传到记步骤。** 带话要经过田头的工单串、投递、合并成一轮的输入，每一层都得加字段，忙时几句话还会合在一起。标记本来就要写给帮工看（它得知道说的是哪一步），由同一个文件写、同一个文件读，客户端只看 `on`。

## Consequences

- 收工、收获以后还能看到帮工的每一步；管家调过哪些工具、拿回了什么，也第一次能看到。
- `activities/`（当时叫 `steps/`）多一种头文件。这次改动以前已经收工的帮工，它们的步骤早就删掉了，所以没有轨迹。
- 管家的轨迹最多留 1000 步，再早的只能去翻 `manager.jsonl`。帮工的仍是 240 步。
- 压缩还没有记成步骤，农场地块详情也照旧只看在场的帮工。思考要农机肯交出来才有。
- 模拟农场有一份简化的轨迹，只在内存里，工具调用是假装的，用来在不连服务端时调界面。（模拟农场后来随 [网页退役](../simplification/2026-10-14-retire-the-web-page.md) 删了，调界面要连一个服务端。）

## Verification

- `server/internal/session/trajectories_test.go`：步骤留着、帮工走了标上结束而且还在、按帮工档案列、新的在前、重开时保留开始的时刻、超过 30 天的只删步骤、头还在、照样列出来，不读目录外的文件。
- `server/internal/workspace/work_test.go`：帮工收工以后，轨迹（工单、帮工档案、项目、三步）还拿得到，也在它的帮工档案名下列出来。
- `server/internal/session/trajectories_test.go` 另测：思考接成一步、中间有别的就另起一步；帮手的步骤挂在派它的调用下面，编号相同的调用和话不串，派它的调用不在了标 -1。
- `server/internal/manager/manager_test.go` 的 `TestForemanToolStart`：管家的工具标签；它的结果和思考怎么读，Go 里没有单独的测试。
- `server/internal/session/rules_test.go`：有字的思考是一步，遮掉的不是；带 `agentPath` 的步骤说明是哪个子 agent 的。
- `app/test/farm_rules_test.dart` 的 `turnEndingAt`：一条消息的这一轮，往回到开始的那句话，不含前一轮和后一轮。
- `server/internal/manager/manager_test.go`：管家派活以后，它的轨迹里依次是收到的话、`dispatch`（标签「派活：demo」，参数里有项目，成功）和它说的话。
- `server/internal/workspace/work_test.go` 的 `TestCrewCommentOnAStep`：评论带着那一步的操作、输入和输出的结尾交给帮工，记下的那一步的 `on` 指回被评论的一步。
- `app/test/rounds_test.dart`：步骤怎么分轮、时间条每段多长、评论挂在哪一步；之前的轮只显示最后说的话，点时间条展开那一步，评论按步号发出去。
