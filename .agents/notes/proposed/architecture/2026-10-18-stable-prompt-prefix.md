# Agent Note: 管家的提示开头不变：时间和农场现状挪进最新那条输入，空闲时用同一个开头压缩

Status: proposed

## Problem

管家跑在 DeepSeek 上，DeepSeek 按前缀缓存：一次请求和上一次请求开头一样的那段按缓存价算，从第一个不一样的字起全价。Grok Bot 的规矩是工具定义、系统提示（含记忆的快照）在下一次压缩前一字不变，时间和「变了什么」放在最新那条消息里，「缓存没命中就是 bug」（[对照 Grok Bot](2026-10-18-always-on-manager.md)第 1、4 项，幻灯片 27:46、29:51、31:31）。

代码里是：

- **系统提示每次请求重拼**：`PrepareRequest`（`pkg/agent/agent.go:181-185`）每次调 `systemPrompt`（`agent.go:260-288`），里面有「现在：」精确到秒（`agent.go:272`，`localeTime` 在 `pkg/agent/schedules.go:108`）、每次重读的 `MEMORY.md`（`agent.go:264`，`ReadMemory` 在 `pkg/agent/memory.go:22`）、管家给的农场现状（`agent.go:267-269` 调 `AgentOptions.Situation`，管家在 `internal/manager/manager.go:424` 接上 `situation()`，`manager.go:309-376`）。系统提示排在最前，时间每秒都变，所以管家**每次请求都从第一段起命不中**。
- **没人量**：每次回答的 `ai.Usage` 有 `CacheRead`、`Input`（`pkg/ai/types.go:177-187`，`Input` 是没命中的那部分），DeepSeek 的 `prompt_cache_hit_tokens` 已经读进来（`pkg/ai/openai_completions.go:228`）；可管家的 `event` 在 `EventMessageEnd` 上只记说了什么（`manager.go:486-506`），轨迹里没有用量这种事件（`internal/protocol/shapes.go:505-514`）。只有命令行把它加起来（`cmd/vibevalley/main.go` 的 `show`）。
- **压缩有两条路，都不复用开头**：请求前估出超过预算就压（`TransformContext`，`agent.go:175-180`）；一轮结束时也压（`ended` 调 `settleFold`，`agent.go:367`、`328-341`）。压缩请求的系统提示是 `SUMMARY_INSTRUCTIONS`，旧对话拼成一段文字当用户消息（`pkg/agent/compaction.go:88-96`），和管家平常的请求没有一个字的共同开头，十几万 token 全价。一轮结束马上压，主人一分钟后接着问，拿到的已经是有损的摘要。
- **原样留下的是最近 12 条消息**（`agent.go:124-127`，`CutPoint` 在 `compaction.go:26-32`），工具调用和结果也算条数，留下的管家对主人说的话可能只有一两句。
- `remember` 工具的描述写着「记下的会出现在你以后每次的系统提示里」（`pkg/agent/self.go:40`）。
- `manager.go:35-36` 的注释说没叫醒管家的汇报以隐藏的 `farmNews` 消息进对话，代码里没有 `farmNews`：`news()` 是拼在这条输入后面一起存进对话的（`manager.go:617-620`）。

## Proposal

### 1. 三段：不变的开头、只往后加的对话、最新那条输入

| 段 | 放什么 | 什么时候变 |
|---|---|---|
| 开头 | 工具定义（`internal/manager/tools.go:740-743` 的固定列表加 `pkg/agent` 自己的 `load_skill`、`remember`、`rewrite_memory`、`search_archive`）；系统提示：说明（`managerSystemPrompt + managerAgentPrompt`）、`## 环境`（只有工作目录）、技能清单、记性的快照 | 会话打开时、每次压缩之后；服务端换了版本（工具描述、说明改了）时 |
| 对话 | 存在 `manager.jsonl` 里的消息，只往后加 | 每条消息 |
| 最新那条输入 | 按这个顺序：`【现在】2026/10/18 02:15`（到分）、`【农场现状】`（全文）或 `【农场变了】`（只有变了的行）、`【记性有更新】`、「这期间田头上的汇报」（`news()`）、最后是这次的话（「主人说：……」「【巡查】……」） | 每条输入；和对话一起存下，以后就是对话的一部分 |

`pkg/agent` 的改动：

- `Agent` 加 `prefix string` 和 `parts []promptPart`（`{name, text}`，名字是 `instructions`、`env`、`skills`、`memory`）。`refreshPrefix()` 重拼它们；`NewAgent` 末尾调一次，`settleFold`、空闲压缩（第 3 节）和 `fold` 真的换了消息之后各调一次。`PrepareRequest` 只读 `a.prefix`，不再调 `systemPrompt`。
- `## 环境` 去掉「现在」。`localeTime` 留给定时的描述（`schedules.go` 的 `DescribeJob`），另加 `localeMinute`（`2006/1/2 15:04`）给管家的输入用，放在 `pkg/agent`，管家经导出的 `vvagent.LocaleMinute` 用。
- `AgentOptions.Situation` 删掉：唯一的用法是管家（`manager.go:424`），农场现状改由管家拼进输入。
- 加 `func (a *Agent) MemoryNews() string`：比较 `ReadMemory` 现在的内容和快照加上已经告诉过模型的部分，返回多出来的行（`+ `）和没了的行（`− `），并把它们记成已经告诉过；没有变化返回 `""`。快照刷新时清空「已经告诉过」。记忆搬进 SQLite 以后，快照换成本地来源的 `SystemPromptBlock`，这个方法照旧（[记忆都存在 SQLite](2026-10-18-memory-in-sqlite.md)第 5 节）。
- `remember` 的描述改成「记下的在下一次整理对话后进系统提示；在那之前，这次的结果就在对话里」。

`internal/manager` 的改动：

- 新文件 `internal/manager/situation.go`：现在的 `situation()` 挪进来，加纯函数 `situationDelta(before, now string) string`：按行比较，`now` 里多的行前面加 `+ `，`before` 里有、`now` 里没的加 `− `；变了的行超过 `now` 的一半行数时返回 `now` 全文（这时差异比全文还难读）。
- `manager` 加 `shown string`：上一次放进输入的农场现状全文。`""` 时放全文，否则放 `situationDelta(shown, now)`，差异为空就不写这一段；放完 `shown = now`。`brainOf` 新建大脑时、收到 `EventCompactionEnd` 且 `Compaction != nil` 时把 `shown` 清空，所以压缩之后的第一条输入又带全文。
- `sendInput`（`manager.go:583-622`）按上表的顺序拼输入：时间、现状、`brain.MemoryNews()`、`news()`、这次的话。`managerSystemPrompt` 里「先看每条消息开头的『农场现状』」（`manager.go:54`）改成「每条输入开头有现在的时间和农场现状（或者变了什么）」。
- 删掉 `manager.go:35-36` 过时的注释。

### 2. 量出来：每次回答记一条用量

- `internal/protocol/shapes.go` 加事件类型 `SessionEventTypeLLMUsage = "llm/usage"`，`SessionEvent` 加 `Tokens *EventTokens`；`EventTokens{Input, CacheRead, Output int64}`。跑 `go run ./tool/shapegen`。
- 管家的 `event` 在 `EventMessageEnd` 上（`manager.go:486`）记一条：`fm.trace.Note(protocol.SessionEventTypeLLMUsage, text, nil)`，带上 `Tokens`。`text` 是「缓存命中 82%：读缓存 41 200，没命中 8 900，输出 310」，命中率 = `CacheRead / (CacheRead + Input)`。`Journal.Note` 现在不带 `Tokens`，加一个 `Usage(tokens EventTokens, text string, from From)` 方法到 `session.Journal`（`internal/session/types.go:61-74`）。
- 开头变了要看得出是哪一段：`pkg/agent` 每次请求对 `parts` 的每一段和工具定义（名字、描述、参数的 JSON）各算一个 sha256，和上一次请求比；两次请求之间没有压缩、某段却变了，就发一个 `AgentEvent{Type: EventPrefixChanged, Reason: "memory,tools"}`。管家把它接在那一条用量的字后面（「；开头变了：工具」），并 `log.Printf`。服务端换版本后的第一次请求会报一次「工具」或「说明」，这是预期的（[有意不同的](2026-10-18-always-on-manager.md#有意不同的)）。
- Flutter：`app/lib/shared/work_log.dart` 里按 `SessionEventType` 分支的三处（`work_log.dart:328`、`339`、`463`）加 `llmUsage`，标签「缓存」，颜色和 `llmRetry` 一档；生成的枚举一变，编译器会指出这三处。管家页的日志里每次回答下面一行小字。

### 3. 不在场时压缩，用同一个开头

- **时机**：`ended`（`agent.go:358-385`）不再调 `settleFold`。改成：一轮停下后估一次 token（`EstimateTokens`），超过 `IdleFoldAt` 就开一个 `IdleFoldAfter` 的计时器。`deliver`（`agent.go:393-409`）和 `Reset` 停掉计时器。计时器到了：大脑在忙或有排着的输入就不压；`AgentOptions.WakeSoon != nil && WakeSoon(IdleFoldAfter)` 就不压；否则压缩，把摘要追加进会话文件（照 `settleFold` 现在的写法），`refreshPrefix()`，发 `EventCompactionEnd`（`Reason: "idle"`）。
- **默认值**：`IdleFoldAt` 是预算的八成（预算 12 万时 96 000），`IdleFoldAfter` 是 10 分钟（照 Grok Bot；DeepSeek 的缓存在磁盘上，留得比 10 分钟久，所以这里取的是「主人多半不会马上接着说」的时长，不是缓存的寿命）。`AgentOptions` 加这两个字段，0 用默认值，`IdleFoldAfter < 0` 关掉。
- **管家的 `WakeSoon`**：管家的定时里有一个（`agent` 为空、`enabled`）在接下来 10 分钟内到点（`protocol.NextRun`，`internal/protocol/schedules.go:172`），就返回 true：反正马上要醒，醒来那次请求超了预算会照旧在请求前压。
- **复用开头的摘要请求**：`compaction.go` 加 `compactInPlace`：`ai.Context{SystemPrompt: a.prefix, Tools: 同一份工具, Messages: ConvertToLlm(全部消息) + 一条用户消息 SUMMARY_IN_PLACE}`，`StreamOptions.ToolChoice = "none"`（`pkg/ai/types.go:500-509`）。`SUMMARY_IN_PLACE` 照 `SUMMARY_INSTRUCTIONS` 的要求写，开头说明「上面的对话要压成一份摘要给接下来的你看；只写摘要，不调工具」。回答出错、为空或带了工具调用，退回现在的 `compact`（单独的系统提示、拼成文字）。归档照旧（`Archive`，`compaction.go:90`）。请求前的那条路（`fold`）也用 `compactInPlace`：一轮太长时中途压，同样省。
- **原样留下管家说的话**：`CompactionOptions` 加 `KeepSaid`（默认 3）。`CutPoint` 在算出切点后继续往前挪，直到切点之后至少有 `KeepSaid` 条带字的 `assistant` 消息，或者挪到 0。摘要覆盖的是整段对话，切点之后的消息原样留下，两者有重叠，这是复用开头的代价。

### 4. 步骤

1. 第 2 节（量），先在真实使用里记一周，作为基准。
2. 第 1 节（开头不变、现状进输入），和 `pkg/agent` 的测试一起改。
3. 第 3 节（空闲压缩、复用开头的摘要）。
4. 再记一周，和基准比命中率和花费；结果写回本篇。

### 5. 测试

- `pkg/agent`：替换 `TestTheHostsSituationIsNeverSaved`（`pkg/agent/agent_test.go:446`）为「同一个会话连着两次请求，中间改了 `MEMORY.md`、时间过了一分钟，`FauxProvider` 收到的两个 `SystemPrompt` 一字不差，第二次输入里有 `【记性有更新】`」。
- `pkg/agent`：压缩之后的第一次请求，`SystemPrompt` 换成新的快照；`EventPrefixChanged` 只在两次压缩之间开头变了时发。
- `pkg/agent`：`IdleFoldAfter` 设 50 毫秒：超过 `IdleFoldAt` 的一轮停下后，计时到了才有摘要请求；摘要请求的 `SystemPrompt` 和上一次请求一样、消息是上一次请求的消息加一条；计时期间送进一条输入，就没有摘要请求；`WakeSoon` 返回 true 也没有。`TestALongConversationIsFolded`（`agent_test.go:309`）按新的摘要请求改判断。
- `pkg/agent`：`CutPoint` 的表驱动测试，切点之后至少有 3 条管家说的话。
- `internal/manager`：`situationDelta` 的表驱动测试（加一行、删一行、没变、变了一大半返回全文）。`input_test.go` 的 `TestFarmNewsAndInstructionAreOneModelInput`（`input_test.go:134`）加：第一条输入带 `【农场现状】`，第二条只带 `【农场变了】` 或不带；压缩之后又带全文。
- `internal/manager`：一次回答之后轨迹里有一条 `llm/usage`，`Tokens` 和 `FauxProvider` 给的用量一致。

## Alternatives considered

**系统提示里的时间改成到天，其余不动。** 时间不再每秒变，但农场现状和 `MEMORY.md` 还是常变，系统提示照样常变。

**农场现状做成每次请求都换的、不存下的最后一条消息。** 它在最后，前面的对话都能命中，实现也简单（`PrepareRequest` 里往消息后面接一条）。代价是一轮里每次请求（每调一次工具就是一次）都全价带一遍完整的现状；存下差异只在每条输入带一次，而且模型看得到现状是怎么变过来的。

**一轮结束马上压（现在的做法），只把摘要请求改成复用开头。** 省了全价，可主人一分钟后接着问时拿到的是有损的摘要；等 10 分钟，主人多半已经走开，空闲压缩不挡人。

**主人开始打字时预热缓存（幻灯片 29:51）。** DeepSeek 的缓存在磁盘上，留得久，同一个会话的开头多半还在；先量第 2 节，命中率还低再做。

## Acceptance criteria

- 同一个管家会话连着两次请求（中间有新消息、时间过了一分钟、农场现状变了、记了一条新记性），系统提示的字节一样；有测试。
- 管家页的日志里每次回答有一条「缓存命中 …%」；开头在两次压缩之间变了，那一条写明是哪一段。
- 改完后真实使用一周，同一个会话从第二次请求起的平均命中率高于改之前一周的基准；两周的数写回本篇。
- 一大轮结束、空闲 10 分钟后会话被压缩，摘要请求的读缓存 token 数大于 0；10 分钟内有输入进来就不压；10 分钟内有管家的定时要到点也不压。
- 压缩后留下的消息里至少有管家最后 3 句对主人说的话。
- `go vet ./... && go test ./...`、`bun run go:deadcode`、`bun run flutter:check` 通过。

## Risks

- 农场现状挪到最新输入里、只带差异，模型可能不再像现在这样看重它；要在真实对话里看管家派活准不准，派错了先改回带全文。
- `ToolChoice = "none"` 是否改变 DeepSeek 的前缀判断，没量过；第 3 节上线后看摘要请求的读缓存数，命不中就去掉它、只靠提示「不调工具」。
- 摘要覆盖整段对话、切点之后又原样留下，压缩后的对话比现在长一点。
- 空闲压缩发生在没人看的时候，摘要生成失败只留下「摘要没生成出来，原文见归档」（`compaction.go:99-101`）；和现在一样，原文在 `archive/` 里能用 `search_archive` 找回。
- 只在一份 8 次回答的旧会话上量过命中率（16.5%），收益要第 4 节的两周数据说话。
