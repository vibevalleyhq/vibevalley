# Agent Note: 管家有自己的页面；记性按「手上的活、下回会想起、记下的」展示；语音设置分线路和管家两处

Status: implemented

## Problem

记性有两套，页面上只看得到一半。帮工的记性在数据库里，帮工页的「记性」页签只是一张平铺的列表：看不出它的帮工现在手上是什么活，看不出下回开工会想起哪几条，也看不出哪几条快被挤掉了。管家的记性是 VibeValley 自己的 agent 写的 `manager/MEMORY.md` 和压掉的旧对话 `archive/`，没有接口，也没有页面：管家记了什么、记错了什么，只能去翻文件。

语音设置全挤在「声音」一页。凭据、识别、大模型这些线路上的事，和电话上的管家是谁、怎么开口、用什么音色，放在一起。管家又没有自己的页面，主人想改管家的声音，得去一个叫「声音」的设置页。主人想要的是：每个 agent 的设置放在它自己那里。

## Decision

行为见 [agents-and-runtimes.md](../../../../docs/reference/agents-and-runtimes.md)「管家页」「捏帮工」和 [voice.md](../../../../docs/reference/voice.md)「配置」。

- **管家有自己的页面**（`/manager`，`app/lib/workbench/manager/manager_page.dart`），是帮工页的第一张卡片。管家不是帮工档案（`Agent`，当时叫 `AgentProfile`）：它没有农机、技能和地可配，硬塞进捏帮工页只会多出一堆用不上的页签。它有三个页签：记性、旧账、声音（后来又加了「轨迹」，见 [轨迹](2026-10-13-trajectories.md)）。
- **管家的记性不换存法，页面直接读写那个文件**（`server/internal/memory/memory.go`，接口 `/api/v1/manager/...`）：
  - `MEMORY.md` 一行算一条，按这一行的 hash 认，用来忘掉某一条。
  - 主人替它记的写成「主人交代：……」。这样页面分得清是谁记的，管家读的时候也知道。
  - 文件的读写和搜法放在 VibeValley 自己的 agent（`server/pkg/agent/memory.go`：`MemoryLines`、`ForgetLine`、`ArchiveFiles`、`ReadArchive`、`SearchArchive`）。管家自己的 `search_archive` 工具和页面用的是同一套。
  - 页面显示系统提示还带得下几条，带不下的旧条目在列表里变淡。
- **帮工的记性面板分三块**（`app/lib/workbench/shared/memory_panels.dart`）：
  - **手上的活**：放在最上面，因为它是现在的状态，不是一条笔记。
  - **下回开工会想起**：选一个项目、可以填一句话，就能看到开工时会想起哪几条。
  - **记下的**：能按项目筛，每条写着谁记的、想起过几次。离上限不到 10 条时，标出最先会丢的那几条（`nextForgotten`，和服务端记满时删掉的顺序一致：最久没想起的先丢，`memory/memory.go` 的 `Keep`）。
- **挑法在 memory 包**（`server/internal/memory/recall.go` 的 `pick`、`termsOf`、上限这些常量）：服务端开工时用它挑。页面拿同一份规则做预览，两边挑出来的不会对不上；网页删了以后（[网页退役](../simplification/2026-10-14-retire-the-web-page.md)），Flutter 的预览直接问服务端（`app/lib/workbench/shared/memory_panels.dart` 的 `recallPreviewProvider`，`GET /api/v1/memories/{agent}/recall`），Dart 里没有第二份挑法。怎么从汇报里读「记住：」、提醒块写成什么样，还是服务端的事（`server/internal/memory/memory.go` 读「记住：」，`session/rules.go` 的 `withRecall` 写提醒块）。
- **语音设置还是一份，按归属分两处改**：数据仍是 `settings.json` 里的同一份 `VoiceSettings`。
  - 「声音」页管线路：凭据、区域、识别、语言、断句、大模型、没人时多久离开。
  - 管家页的「声音」页签管电话上的管家：人设、开场白、出错时说的话、音色。
  - 两处是同一个表单（`app/lib/workbench/voice/voice_page.dart` 的 `VoiceSettingsForm`，按 `part` 分），各自的「恢复默认」只动自己那几项。
- **音色先听再选**：MiniMax 音色列表里每个音色旁边有一个 ▶，播的是放在仓库里的样音（`app/assets/voice-samples/`），内容是默认开场白。样音用 `web/scripts/voice-samples.ts` 生成过一次，生成时要一个 MiniMax 的 key，key 只从环境变量读（这个脚本随网页删了，mp3 留着）；页面上试听不需要任何 key。播放和停止是像素素材（`button-play`、`button-stop`），由 codex 照着 Hugeicons 的形状画（`design/pixel/icons/`、`gen.sh media`），不用字符代替。

## Alternatives considered

**把管家做成一个 `AgentProfile`，用捏帮工页。** 页面能直接复用，可管家的大半配置（农机、模型、人设交给农机的方式、技能、worktree）对它都没有意义，模型和运行方式又由环境变量决定。另开一页，只放它真有的东西。

**把管家的记性搬进数据库的 `memory` 表，和帮工用同一个服务。** 页面能完全复用，但管家的 `remember` 和 `rewrite_memory` 工具、系统提示里的那一段，都写死了 `MEMORY.md`。搬过去就要改 VibeValley 自己的 agent 的记性模型，而它也是独立的命令行 agent。先让页面读那个文件，以后真要合并再换。

**在服务端加一个「预览想起什么」的接口。** 规则留在服务端，可模拟服务器又得再写一份，每次换项目、改一个字都要请求一次。挑法本来就是纯函数，放进 protocol 两端都能用。

**给每个帮工档案加音色字段，一起做。** 现在打电话只连管家，帮工的音色没有地方用得上，加了也是摆设。等「田头朗读」或者直接给帮工打电话做了再加（[帮工各自的音色](../../proposed/feature/2026-10-13-helper-voices.md)）。

**试听时现场合成，或者借声网录一段。** 现场合成要服务端有 MiniMax 和 OpenAI 的 key，可平时用的是声网托管的合成，我们手上没有这些 key。借声网录（临时开一个频道请管家开口，页面录下来存着）不用别的 key，自己填的音色 id 也能听，但第一次要等几秒，还要花通话时长。列表里的音色是固定的，预先生成一次最省事；自己填的音色 id 以后要试听，再接上借声网录这条路。

**语音设置拆成两份存。** 两份存法要多一套默认和覆盖的规则，`agora.ts` 也要合并两份。现在只有管家一个人说话，同一份数据分两处改就够了。

## Consequences

- 管家记了什么、什么已经带不进系统提示，主人一眼就能看到，也能删掉记错的。
- 帮工页能预演一轮开工会想起什么，挑法不准时能看出来，不用等帮工干完再去翻干活过程。
- 「主人交代：」这几个字会进管家的系统提示，多占一点字数。
- 按行的 hash 认一条：管家刚好在整理这一行时，页面上的「忘掉」可能落空。刷新以后能看到实际剩下的。
- 管家跑在 pi 上时，记性页只能提示它不读这份记性。（Go 服务端的管家不再能跑在 pi 上：设了 `manager.runtime=pi` 管家就拒绝起来，记性页照旧显示这条提示，见 [服务端用 Go 重写](../architecture/2026-10-13-go-server-on-smith.md)。）
- 样音念的是默认开场白，不是主人改过的那句，听的只是音色。OpenAI 和微软的音色还没有样音。仓库里多了约 540 KB 的 mp3。
- 语音设置分在两页改，每页只把自己那几项存到当时最新的设置上，两页不会互相覆盖。

## Verification

- `server/internal/memory/memory_test.go`：`MEMORY.md` 一行一条、新的在前、管家自己记的和主人交代的分开、按 id 忘掉一行、空话被拒绝、系统提示带得下几条、pi 上标出来、旧账的文件列表和搜索和全文、不读旧账目录外的文件。
- 挑法：`server/internal/memory/recall_test.go`（`TestPickNotes`、`TestPickJobs`、`TestNextForgotten`：记满时先丢最久没用的）和黄金数据 `server/internal/memory/testdata/rules.jsonl.gz`；`memory/memory_test.go` 的 `TestMemoriesKeepRecallWriteForget` 测开工时按它想起、记上想起的次数。Flutter 的预览由服务端算，没有 Dart 的对照。
