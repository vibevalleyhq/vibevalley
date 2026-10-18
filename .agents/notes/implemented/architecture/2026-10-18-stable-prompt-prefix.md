# Agent Note: 管家的提示开头不变：时间和农场现状挪进最新那条输入，空闲时用同一个开头压缩

Status: implemented

## Problem

管家跑在 DeepSeek 上，DeepSeek 按前缀缓存：一次请求和上一次请求开头一样的那段按缓存价算，从第一个不一样的字起全价。Grok Bot 的规矩是工具定义、系统提示（含记忆的快照）在下一次压缩前一字不变，时间和「变了什么」放在最新那条消息里，「缓存没命中就是 bug」（[对照 Grok Bot](2026-10-18-always-on-manager.md)第 1、4 项，幻灯片 27:46、29:51、31:31）。

改之前：

- **系统提示每次请求重拼**：`PrepareRequest` 每次调 `systemPrompt`，里面有精确到秒的「现在：」、每次重读的 `MEMORY.md`、管家经 `AgentOptions.Situation` 给的农场现状。系统提示排在最前，时间每秒都变，所以管家**每次请求都从第一段起命不中**。
- **没人量**：每次回答的 `ai.Usage` 有 `CacheRead`、`Input`（`Input` 是没命中的那部分），DeepSeek 的 `prompt_cache_hit_tokens` 已经读进来；可管家的轨迹里只记说了什么，只有命令行的 `show` 把用量加起来。
- **压缩有两条路，都不复用开头**：请求前估出超过预算就压；一轮结束时也压。摘要请求的系统提示是 `SUMMARY_INSTRUCTIONS`，旧对话拼成一段文字当用户消息，和管家平常的请求没有一个字的共同开头，十几万 token 全价。一轮结束马上压，主人一分钟后接着问，拿到的已经是有损的摘要。
- **原样留下的是最近 12 条消息**，工具调用和结果也算条数，留下的管家对主人说的话可能只有一两句。

## Decision

### 三段：不变的开头、只往后加的对话、最新那条输入

| 段 | 放什么 | 什么时候变 |
|---|---|---|
| 开头 | 工具定义（管家的固定列表加 `internal/agent/brain` 自己的 `load_skill`、`remember`、`rewrite_memory`、`search_archive`）；系统提示：说明（`managerSystemPrompt + managerAgentPrompt`）、`## 环境`（只有工作目录）、技能清单、记性的快照 | 大脑起来时、每次压缩之后；服务端换了版本（工具描述、说明改了）时 |
| 对话 | `manager.jsonl` 里的消息，只往后加 | 每条消息 |
| 最新那条输入 | 按这个顺序：`【现在】2026/10/18 02:15`（到分）、`【农场现状】`（全文）或 `【农场变了】`（只有变了的行）、`【记性有更新】`、「这期间田头上的汇报」、最后是这次的话（「主人说：……」「【巡查】……」） | 每条输入；和对话一起存下，以后就是对话的一部分 |

`internal/agent/brain`：

- `Agent` 有 `prefix` 和 `parts []promptPart`（名字是 `instructions`、`env`、`skills`、`memory`）。`refreshPrefix()` 重拼它们：`NewAgent` 里一次；`fold` 做出新的摘要之后一次（请求前的压缩、一轮停下时存下的压缩、空闲压缩，空闲压缩只在摘要真的换上之后）。`PrepareRequest` 只读 `a.prefix`。
- 请求前的压缩在 `PrepareRequest` 里、读 `a.prefix` 之前，不在 `TransformContext` 里：`agentcore` 先调 `PrepareRequest` 再调 `TransformContext`，放在后者里，压缩后的第一次请求会带着旧的开头、第二次才换，多命不中一次。
- `localeTime` 留给定时的描述；`LocaleMinute`（`2006/1/2 15:04`）给输入用。`AgentOptions.Situation` 没有了。
- `MemoryNews()`：比较 `MEMORY.md` 现在的行和模型已知的行（快照的行，加上之前告诉过的变化），返回 `【记性有更新】` 加多出来的行（`+ `）和没了的行（`− `），并记成已知；没有变化返回 `""`。快照刷新时，已知的行换成新快照的。比的是文件的行（去掉列表符号），不是 `ReadMemory` 截过的那段，截断处的半行不会每次都报。
- `remember` 的描述是「记下的在下一次整理对话后进系统提示；在那之前，这次的结果就在对话里」。

`internal/manager`：

- `situation.go`：`situation(conversation)` 拼农场现状。拼的时候还不知道这条输入会在哪次请求里被读，「你正在回话的频道」由这条输入的频道给，写在末尾单独一行，换个频道回话只变一行。
- 纯函数 `situationDelta(before, now)`：按行比较，多的行加 `+ `，没了的加 `− `；列表项（`- ` 开头或缩进的行）连同它上面那个标题一起比，「（没有帮工）」在两个频道下是两行，差异里列表项前面先写它的标题；变了的行超过 `now` 的一半时返回 `now` 全文（这时差异比全文还难读）；没变返回 `""`，输入里就不写这一段。
- `manager.shown` 是上一次放进输入的现状全文：`""` 时放全文，否则放差异；`brainOf` 新建大脑时、收到带 `Compaction` 的 `compaction_end` 时清空，压缩之后的第一条输入又带全文。
- 管家忙着（在跑，或有排着的输入）时交进去的输入，可能排在后交的输入后面才被读（插话先于排队的），差异的底就不对了：这时放全文，并把 `shown` 清空，下一条也放全文。从读现状到交进去由一把锁（`inputs`）连着，两条输入的先后和差异的先后一致。
- `sendInput` 按上表的顺序拼输入；轨迹的 `user/message` 只记这次的话。

### 量出来

- 事件类型 `llm/usage`，`SessionEvent.Tokens` 是 `EventTokens{Input, CacheRead, Output}`；`session.Journal.Usage` 记它。管家在每次回答的 `message_end` 上记一条，字是「缓存命中 82%：读缓存 41 200，没命中 8 900，输出 310」（命中率 = `CacheRead / (CacheRead + Input)`）；一个 token 都没有的（还没开口就出错）不记。摘要请求的用量也记一条，字前面加「整理对话，」，`compaction_end` 带着它的 `Usage`。
- `internal/agent/brain` 每次请求对每一段和工具定义（名字、描述、参数的 JSON）各算一个 sha256（`prefix.go`），和上一次请求比；两次之间没有压缩、某段却变了，发 `PrefixChanged`，`Parts` 是变了的段名。管家把它接在下一条用量的字后面（「；开头变了：工具」），并 `log.Printf`。
- 哈希只在内存里，比的是同一个进程里的上一次请求：重启后的第一次请求不比，重启本来就从头建缓存，那一条的命中率看得出来。`prefix_changed` 在请求前直接发，用量经 `agentcore` 的事件转一手再发，在管家那里两条的先后靠转发跟得上；接错也只是字落在相邻的那条用量上。
- Flutter 的工作日志（`app/lib/shared/work_log.dart`）把 `llm/usage` 画成一行小字，标签「缓存」，颜色和 `llm/retry` 一档。

### 不在场时压缩，用同一个开头

- **时机**：一轮停下时，这一轮里请求前压过的，把那次的摘要存下（多半就是缓存里那份，不再请求）：对话本来已经超了预算，这一轮用的就是摘要。没压过的，估出超过 `IdleFoldAt` 就开一个 `IdleFoldAfter` 的计时器（`internal/agent/brain/idle.go`）。交进输入、`Reset`、`Close` 停掉它。到点时大脑在忙或有排着的输入就不压，`WakeSoon(IdleFoldAfter)` 为真也不压；否则压缩。摘要要花几秒，其间可能有输入进来、开了一轮：换消息之前在 `a.mu` 下再看一次，大脑不闲或消息变了，这份摘要就丢掉，对话文件和开头都不动，下次闲下来再压。
- **默认值**：`IdleFoldAt` 是预算的八成（96 000），`IdleFoldAfter` 是 10 分钟（照 Grok Bot；DeepSeek 的缓存在磁盘上，留得比 10 分钟久，这里取的是「主人多半不会马上接着说」的时长，不是缓存的寿命）；0 用默认值，`IdleFoldAfter < 0` 关掉。
- **管家的 `WakeSoon`**：管家自己的定时（`agent` 为空或是 `manager`、开着）有一个在这段时间内到点（`protocol.NextRun`），就为真：反正马上要醒，醒来那次请求超了预算会照旧在请求前压。
- **复用开头的摘要请求**：`compactInPlace` 发 `SystemPrompt: a.prefix`、同一份工具、全部消息加一条 `SUMMARY_IN_PLACE`，`ToolChoice` 是 `none`。回答出错、为空或带了工具调用，退回 `compact`（`SUMMARY_INSTRUCTIONS`、拼成文字）。归档照旧。请求前的压缩也走它。
- **原样留下说的话**：`CompactionOptions.KeepSaid` 是 3。`CutPoint` 算出切点后继续往前挪，直到切点之后至少有 `KeepSaid` 条带字的 `assistant` 消息，或者挪到 0。挪到 0 就永远压不了（一大轮里全是工具调用、说过的话不到 3 句时会这样），挪得太远又省不下什么，所以挪到 0、或者留下的部分估出超过预算的一半时，退回不算 `KeepSaid` 的切点。摘要覆盖整段对话，切点之后的消息又原样留下，两者有重叠，这是复用开头的代价。

## Verification

- `internal/agent/brain`：`TestTheSystemPromptStaysTheSameBetweenFolds`（中间记了一条、忘了一条，两次请求的系统提示一字不差，`MemoryNews` 报一次、第二次为空，没有 `prefix_changed`）；`TestAFoldMakesTheSystemPromptAnew`（压缩之后的请求带新的快照，不报 `prefix_changed`）；`TestAChangedToolIsToldAsAChangedPrefix`；`TestAnIdleConversationIsFoldedWithTheSameStart`（计时到了才压，摘要请求的系统提示和工具和上一次请求一样、消息是上一次请求的消息加上回答和一条要摘要的话，`ToolChoice` 是 `none`；三次连着问，中间没有摘要请求）；`TestAToolCalledInsteadOfASummaryIsAskedAgainOnItsOwn`；`TestNoIdleFoldWhenItWillBeWokenSoon`；`TestCutPointKeepsTheLastWords`；`TestALongConversationIsFolded` 按新的摘要请求认。
- `internal/manager`：`TestSituationDelta`；`TestTheSituationIsWholeOnlyAfterAFold`（第一条全文，第二条只有变了的行，第三条没有这一段，压缩之后又是全文）；`TestEachAnswerLeavesItsTokensInTheLog`、`TestUsageText`；`TestOnlyItsOwnScheduleSoonKeepsTheManagerFromFoldingIdle`。

## Alternatives considered

**系统提示里的时间改成到天，其余不动。** 时间不再每秒变，但农场现状和 `MEMORY.md` 还是常变，系统提示照样常变。

**农场现状做成每次请求都换的、不存下的最后一条消息。** 它在最后，前面的对话都能命中，实现也简单（`PrepareRequest` 里往消息后面接一条）。代价是一轮里每次请求（每调一次工具就是一次）都全价带一遍完整的现状；存下差异只在每条输入带一次，而且模型看得到现状是怎么变过来的。

**差异在输入被读到时才算。** 排着的输入被读的先后和交进去的先后可能不同，在被读时算才总是对的；可输入一交进去就是定下的消息，读的时候改它要动 `agentcore` 的队列。忙时放全文简单，只多花在忙时交进去的那几条上。

**一轮结束马上压，只把摘要请求改成复用开头。** 省了全价，可主人一分钟后接着问时拿到的是有损的摘要；等 10 分钟，主人多半已经走开，空闲压缩不挡人。

**主人开始打字时预热缓存（幻灯片 29:51）。** DeepSeek 的缓存在磁盘上，留得久，同一个会话的开头多半还在；先看 `llm/usage` 的命中率，还低再做。

## Consequences

- 同一个会话从第二次请求起，开头（工具和系统提示）在两次压缩之间一字不变；变了的话日志里那条用量写明是哪一段。改之前只在一份 8 次回答的旧会话上量过命中率（16.5%）；改之后的命中率要从真实使用的 `llm/usage` 看。
- 农场现状只在每条输入带一次、多数时候只带差异；模型可能不再像以前那样看重它，派错了先让每条都带全文。
- `ToolChoice = "none"` 是否改变 DeepSeek 的前缀判断没量过；摘要请求的那条「整理对话」用量的读缓存数为 0 时，就去掉它、只靠提示「不调工具」。
- 摘要覆盖整段对话、切点之后又原样留下，压缩后的对话比以前长一点。
- 空闲压缩发生在没人看的时候，摘要生成失败只留下「摘要没生成出来，原文见归档」；原文在 `archive/` 里能用 `search_archive` 找回。
- 新记下的记性在下一次压缩前不进系统提示，只在那之后的第一条输入里出现一次；之后靠它还在对话里。
