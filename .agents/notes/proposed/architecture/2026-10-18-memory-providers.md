# Agent Note: 记性有多个来源：照 Hermes 的接口，统一的工具，本地用 SQLite 全文检索

Status: proposed

## Problem

记性现在只有一种存法：帮工档案的记忆在 SQLite 的 `memory` 表里，按共有的词和新旧挑（[每个 agent 的记性](../../implemented/architecture/2026-10-11-agent-memory.md)），管家的偏好在 `MEMORY.md`。主人要接外面的记忆服务，而且不止一家：

| 来源 | 写进去的是什么 | 谁来提炼 | 范围 | 怎么取 |
|---|---|---|---|---|
| 本地 | 提炼好的一条：「记住：」的行、做过的活 | 帮工自己写 | 档案、项目 | 我们的纯函数 `pick` |
| Nowledge Mem（MCP，本机 `http://127.0.0.1:14242/mcp/`） | 提炼好的一条（`memory_add`），也能同步整段对话（`sync_thread`） | 调用方 | `agent_id`、`space_id`、label | `memory_search`，语义检索 |
| [EverOS](https://github.com/EverMind-AI/EverOS)（HTTP `/api/v2`） | 整段对话（`memory/add` 送 messages，会话结束 `memory/flush`） | 它自己用 LLM 提炼，Reflection 在会话之间合并 | `user_id`、`agent_id`、`app_id`、`project_id`、`session_id` | `memory/search`，关键词、向量或混合 |

三家写进去的东西不一样，不能只抽「存一条、取一条」。

另外两处不够：

- 帮工只在开工时被动拿到几条，干到一半想查「这个项目的测试怎么跑」没有办法。原来否决过给帮工记忆工具，理由是「要靠它记得去调」；可自动想起和工具并不冲突，而管家本来就有 `remember`、`search_archive`。
- `pick` 按「相邻的两个汉字」和拉丁字母的词数共有的词，不看词频，也分不出「测试」是一个词。

## Proposal

### 1. 一个来源的接口，照 Hermes 的 `MemoryProvider`

[Hermes](https://github.com/NousResearch/hermes-agent) 的 `agent/memory_provider.py` 是一个抽象类，每个记忆来源实现它，`agent/memory_manager.py` 统一调度。我们照它的方法写 Go 接口，名字一一对应，参数换成我们的概念：

```go
// internal/memory: one place memories live. Modeled on Hermes's MemoryProvider.
type provider interface {
	Name() string                         // name: local, nowledge, everos
	Available() (bool, string)            // is_available + unavailable_reason; no network
	Initialize(ctx context.Context) error // initialize: an MCP session, an HTTP client
	Shutdown()                            // shutdown: drain the write queue, close

	SystemPromptBlock(scope Scope) string                     // system_prompt_block: fixed text; "" for none
	Prefetch(ctx context.Context, cue RecallCue) ([]Recalled, error) // prefetch: before a run; the caller bounds it
	Search(ctx context.Context, q SearchQuery) ([]Recalled, error)   // behind memory_search
	Add(ctx context.Context, n Note) (protocol.Memory, error)         // behind memory_add

	SyncTurn(ctx context.Context, run FinishedRun) error     // sync_turn: one finished run, everything about it
	OnSessionEnd(ctx context.Context, s EndedSession) error  // on_session_end: EverOS flushes here
	OnMemoryWrite(ctx context.Context, w MemoryWrite) error  // on_memory_write: add, replace, remove outside a run

	List(ctx context.Context, scope Scope) ([]protocol.Memory, error) // the 记性 tab; Hermes has no listing
	Forget(ctx context.Context, id string) error

	ToolSchemas() []ToolSchema                                                // get_tool_schemas: its own extra tools
	HandleTool(ctx context.Context, name string, args json.RawMessage) (string, error) // handle_tool_call
	ConfigSchema() []ConfigField                                              // get_config_schema: what the settings ask
	Can() Abilities                                                           // what it does: list, forget, want transcripts
}
```

- `Scope` 是 `Owner`、`Agent`、`Project`、`Session`，各来源自己翻译：EverOS 是 `user_id`、`agent_id`、`project_id`、`session_id`，`app_id` 固定 `vibevalley`；Nowledge 是 `agent_id`，项目做 label，`source_app` 固定 `vibevalley`。
- `SyncTurn` 给全部材料：「记住：」的行、汇报、这一轮的对话。各来源拿自己要的：本地收那几行和做过的活，Nowledge 用 `memory_add` 收那几行，EverOS 把对话交给 `memory/add`，会话结束时在 `OnSessionEnd` 里 `flush`。
- `Recalled` 带来源的名字和分数，供合并和页签显示。
- 记忆分四类，和 Hermes 一样（[记忆都存在 SQLite](2026-10-18-memory-in-sqlite.md)第 1 节）：精选记忆（`profile`、`note`）、经过（`issue`、`episode`）、技能、外接来源。`SearchQuery` 带 `Kind`，各来源照自己的东西翻译：

  | 我们的种类 | 本地 | Nowledge Mem | EverOS |
  |---|---|---|---|
  | `profile` | `memory` 表 | `read_context_bundle`，或带主人 label 的 `memory_search` | user profile |
  | `note` | `memory` 表 | `memory_search`、`memory_add` | agent 的 cases |
  | `issue`、`episode` | `memory` 表 | `thread_search`、`thread_fetch_messages` | episodes |
  | 技能 | 技能书（不经这个接口） | `find_skills`（不经这个接口） | agent 的 skills（不经这个接口） |

  某一类一家没有，就对那一类回空。技能不经这个接口：它要主人批才生效，走技能书（[先采样，再验收](2026-10-14-sample-then-verify.md)第 4 步）。
- 现有的 `RecallCue`、`FinishedRun`（`server/internal/memory/types.go`）扩成这里的形状。

Hermes 有、这次不要的：`on_turn_start`（我们的单位是 run，不是对话的一轮）、`on_pre_compress`（压缩是各家农机自己的事，服务端看不到）、`on_session_switch` 和 `identity_signature`（一个进程服务多个会话、多个人是 Hermes 网关的场景）、`on_delegation`（计划拆出的是子工单，各有自己的 run）、`recall_status`（`Recalled` 带来源就够）、`save_config` 和 `backup_paths`（配置在 `settings.json`，备份就是家目录）。

### 2. 管理器：多个来源同时开，读并行，写各自收

照 `MemoryManager` 写一个不导出的 `providers`，`internal/session`、`internal/manager`、`internal/mcp` 和记性页签只调它：

- **读**（`PrefetchAll`、`SearchAll`）：并行问所有启用的来源，每个来源单独超时（Hermes 给外接的 8 秒；开工前的预取宜更短，先定 2 秒），超时或出错就跳过、只记日志，不拦着干活。结果按分数合并，去掉几乎一样的（沿用 `memoryLikeness`），按总预算截断（现在是 8 条、1600 字），每条标上来源。
- **写**（`SyncAll`、`AddAll`、`OnMemoryWriteAll`）：每个来源在设置里自己决定收不收。写入放在后台的一个工作者上按顺序做，不让收工等外面的服务。
- **发出去之前抹掉密钥**：帮工的对话里可能有 key；送给 Nowledge、EverOS 之前，按服务端日志的同一套规矩抹掉（Hermes 的 `_redact_for_provider`）。
- **id 带来源**：`local:12`、`nowledge:<id>`、`everos:<id>`，「忘掉」照前缀找到那一家。
- **本地那一份一直在**：其余的在设置里一个来源一项，写明种类、地址、凭据、读写、启用没有。

Hermes 只许开一个外接来源，因为每个来源都往 agent 身上加自己的工具。我们换成第 3 节的统一工具，来源再多，agent 看到的工具也不变，所以放开。

### 3. 统一的工具：管家和帮工都能主动记、主动查

| 谁 | 从哪拿到 | 工具 | 范围 |
|---|---|---|---|
| 管家 | `internal/manager` 的工具表 | `memory_search`、`memory_add`，按 id 的 `memory_replace`、`memory_remove`（取代整份重写的 `rewrite_memory`），`search_archive` 照旧 | 主人和管家；可以查任何档案 |
| 帮工 | 农场的 `/mcp`（`internal/mcp`，和 `channel_say` 并排） | `memory_search`、`memory_add` | 由会话的令牌定死：自己的档案和当前项目，写不进别人的 |

- `memory_search` 走 `SearchAll`，`memory_add` 走 `AddAll`。
- 开工前的 `Prefetch` 和收工时收「记住：」的行都留着：不能指望 agent 每次都记得去查，有的农机也接不了 MCP。
- 来源自带的工具（Nowledge 的 `thread_search` 等）默认不给，设置里按来源单独打开；打开了由管理器替它注册、转发调用。

### 4. 本地来源：SQLite，FTS5 的 `bm25()`，gse 切词

表结构、索引、排序和搬家写在[记忆都存在 SQLite](2026-10-18-memory-in-sqlite.md)；这里只留选型。

- **还用 SQLite**，形状照 Nowledge 扩：`title`、`labels`、`importance`、类型（记下的话、做过的活、偏好、流程……）、谁记的、取代了哪条（`supersede`，原来「差不多就不记」改成新的取代旧的）。表结构的改动照规矩加一个迁移，表名照「模块_概念」。
- **检索**：一张 FTS5 的虚表放切好的词，`bm25()` 排序，再叠上现有的偏好（这个项目先于所有项目，新的先于旧的）。`modernc.org/sqlite` v1.60.1（SQLite 3.53.4）自带 FTS5 和 `bm25()`，2026-10-18 测过。
- **中文切词用 [gse](https://github.com/go-ego/gse)**（纯 Go，Apache-2.0）。FTS5 自带的分词器都不行：`unicode61` 把一串中文当一个词，「测试」搜不到「这个项目测试用 pnpm test」；`trigram` 三个字起，两个字的词搜不到。
  - 入库用 `CutSearch`；查询用 `CutSearch` 和 `CutAll` 的并集：「表名单数」`CutSearch` 切成「表 / 名单 / 数」，只有并上 `CutAll` 才有「单数」，搜得到「表名用单数」。
  - 英文词 gse 转成小写，入库和查询两边一样。
  - **只嵌简体词典**：`LoadDictEmbed()` 会把 gse 的日文（23 MB）、繁体、idf 词典全链进来，二进制从 9 MB 变成 41 MB。不调它，把 gse 的 `data/dict/zh/s_1.txt` 用 gzip 压成 1.9 MB 放进 `internal/memory`，`go:embed` 进去、`LoadDictStr` 加载，二进制是 12 MB。`NOTICE` 写明出处（gse 的 Apache-2.0，词典来自结巴分词，MIT），文件旁记下取自 gse 的哪个版本。
  - 加载约 350 ms，第一次检索时再加载，或者开机后在后台加载。
- `pick` 换成这条检索以后，「下回开工会想起什么」的预览和「快忘了」的标记照旧由本地算；外面的来源，预览直接问它，没有「快忘了」。

### 5. 管家的记性和主人画像也进本地来源

本地来源的表、索引、查询和搬家见[记忆都存在 SQLite](2026-10-18-memory-in-sqlite.md)：管家的 `MEMORY.md` 拆成所有 agent 共享的主人画像和管家自己的记忆，都在同一张表里，由本地来源的 `SystemPromptBlock` 给出（对应 Hermes 内置的 `USER.md` 和 `MEMORY.md`）。以后把外面来源里关于主人的部分（Nowledge 的 `read_context_bundle`、EverOS 的 user profile）也经 `SystemPromptBlock` 拼进去，那一步不在本提案里。

### 步骤

每步单独一个改动，各自能过检查：

1. **接口和本地来源**：抽出 `provider` 和管理器，本地照第 4 节改造（迁移、FTS5、gse），行为和现在一样或更准；`pick` 的黄金数据跟着重写。
2. **统一的工具**：管家的 `memory_search`、`memory_add`，帮工经 `/mcp` 的两个工具。
3. **Nowledge Mem**：MCP 客户端用已有的 `github.com/modelcontextprotocol/go-sdk`；设置里的来源表、记性页签按 `Can()` 显示。
4. **EverOS**：HTTP 客户端，`SyncTurn` 送对话、`OnSessionEnd` 时 `flush`。

### 做到哪了

2026-10-18 做了第 1 步的接口那一半：`server/internal/memory/provider.go` 是接口，`providers.go` 是管理器，`local.go` 把原来的 `memories` 包成本地来源，行为不变（`internal/session` 和处理函数没改）。接口里只放了现在有人调的方法（`Name`、`Available`、`OnStart`、`OnStop`、`Prefetch`、`SyncTurn`、`List`、`Add`、`Forget`），其余的等第一个调用的人来了再加：`go:deadcode` 不留只靠测试活着的方法。已知的缺口：几个来源一起想起时，本地挑出、合并时又被挤掉的那几条，也记成了想起过；只有本地一个来源时不会发生，接第二个来源时改成合并之后再记。本地的存法（迁移、FTS5、gse）还没做，见[记忆都存在 SQLite](2026-10-18-memory-in-sqlite.md)。

第 2 步做了：接口多了 `Search`，管理器的 `Search` 并行问所有来源（外面的照样最多等 2 秒），各来源的分数不能比，所以按名次轮流取，几乎一样的（`memoryLikeness` ≥ 0.8）只留一条，默认 10 条；本地的检索是 `recall.go` 的纯函数 `search`（共有的词、整句出现，同项目的在前），等 FTS5 来了换掉。管家的 `memory_search`、`memory_add` 在 `manager/tools.go`，帮工的在 `mcp/mcp.go`，回给模型的话都由 `memory.FoundText` 拼。和提案不一样的：管家的 `memory_add` 只替帮工档案记，管家自己的照旧 `remember`（管家的记性还在 `MEMORY.md`，等[记忆都存在 SQLite](2026-10-18-memory-in-sqlite.md)第 4 步）；`memory_replace`、`memory_remove` 也等那一步；`SearchQuery` 有 `Kind`，工具还没给模型这个参数。

第 3 步做了：`memory/nowledge.go` 用 go-sdk 的 MCP 客户端（Streamable HTTP，不开常驻的 SSE），第一次用时才连，连不上下次再连；SDK 的请求不随 ctx 结束（它把连接的 ctx 摘开了），所以调用方到点就不等，请求本身由 HTTP 客户端的 30 秒超时收掉。2026-10-18 对主人本机的 Nowledge Mem 0.10.103 只调过 `initialize`、`tools/list` 和只读的 `memory_search`：它有 75 个工具，我们只用 `memory_search`（`query`、`limit` ≤ 20、`filter_labels`、`source_app`；回 `results[]` 的 `memory_id`、`title`、`content_preview`、`relevance_score`）和 `memory_add`（`content`、`title`、`labels`、`source_app`）。来源在设置里（`settings.json` 的 `memorySources`），存了就用上；接口加了 `Can()`，记性页签按它显示，`MemoryList` 多了 `sources`、`Memory` 多了 `source`。抹密钥的规则在 `base/redact.go`，服务端日志（`cmd/server` 的 `log.SetOutput`）和发往外面来源的字都过它：原来服务端日志并没有抹密钥的规则，这一步一起加上。「做到哪了」里的缺口修了：本地来源的 `Prefetch` 不再记想起过，管理器合并以后只给真放进话里的本地记忆记一次；合并也从按分数排改成各来源轮流取，因为各家的分数比不了（本地的是名次，Nowledge 的是 0 到 1）。

和提案不一样的：
- Nowledge 的范围不用 `agent_id`：试过，它不认识的 agent_id 就退回默认的空间，隔不开档案；改用 label（`vibevalley-agent-<档案>`、`vibevalley-project-<项目>`），读的时候按档案的 label 过滤。主人自己的记忆默认不读，设置里打开「读全部」才读，那时每个档案读到的一样。
- Nowledge 里的记忆在页签上列得出、忘不掉（`Can().Forget` 是假）：那是主人自己的知识库，农场只往里加，删到 Nowledge Mem 里删。
- 写进 Nowledge 只在测试里对着假的 MCP 服务端做过（`memory/nowledge_test.go`）；验收里「收工时「记住：」进了 Nowledge、下回 `memory_search` 能取回」，对真的那一家只验证了读的一半（照 `verify-server`，经 `GET /api/v1/memories/{agent}/recall` 读回了它的记忆），写的一半要主人点头再试。
- 没做 `ConfigSchema`、`ToolSchemas`、`HandleTool`：还没人调；来源自带的工具也就还没法在设置里打开。

第 4 步做了：`memory/everos.go` 照 Raven 的 everos-memory 插件说的那一套（`raven_everos/backend.py`，EverOS 1.2）：`POST /api/v2/memory/add`（`session_id`、`messages[]` 的 `sender_id`、`role`、`timestamp` 毫秒、`content`，`app_id`、`project_id`）、`/memory/flush`（`session_id`）、`/memory/search`（`query`、`top_k` 1..100，`user_id` 和 `agent_id` 二选一；回 `data.agent_cases`、`data.episodes`）。接口加了 `OnSessionEnd`，`session` 在 Session 离开农场时经 `memory.EndSession` 告诉管理器，它在后台转给外面的来源。测试对着 httptest 的假 EverOS（`memory/everos_test.go`），没碰真的 EverOS。

和提案不一样的：
- `SyncTurn` 给的「这一轮的对话」只有工单和帮工最后的汇报：`FinishedRun` 里没有这一轮中间的工具调用和带的话（`session` 只存了它们的消息 id），要整段得另开一条从事件日志取的路。
- 档案的 `agent_id` 写成 `vibevalley-<档案>`、会话写成 `vibevalley-<Session>`：同一个 EverOS 里还有别的应用的 agent（Raven 的），农场的 Session 编号（w1、w2）也只在一个家目录里不重。
- 一轮之外记的一句（页签、`memory_add`）也送：当成主人和档案的两句对话，马上 flush，不然 EverOS 不提炼。
- 没照它的 `/health` 调检索方法（没有向量模型时改 keyword）：检索出错就跳过、记日志；它的 profile 和 skills 不读（profile 等 `SystemPromptBlock`，skills 走技能书）。

还没做的：Nowledge 的 `read_context_bundle`、EverOS 的 user profile 拼进 `SystemPromptBlock`（第 5 节说过不在本提案里）；设置里每个来源按农机排除（风险第一条）；本地来源的 SQLite 改造（[记忆都存在 SQLite](2026-10-18-memory-in-sqlite.md)，等迁移）。

## Alternatives considered

**只能开一个外接来源（Hermes 的做法）。** 它这样限制，是因为每个来源都带自己的工具。我们对 agent 只给一套统一的工具，来源多了工具也不变；而 EverOS 和 Nowledge 主人都要。

**只写一个写入目标，其余只读。** 怕同一条被想起两遍。可 EverOS 要整段对话自己提炼，不给它写它就什么都没有；重复交给读时去重。

**本地改用 Markdown 文件。** 人能直接打开改，EverOS 也以 Markdown 为源。可照 Nowledge 的形状字段多，一行写不下，要自己发明格式；多个帮工同时收工时没有事务；检索还得另建索引。记性页签本来就能看、能写、能删，要 Markdown 以后做导出。

**中文两个字一组（CJK bigram），不要词典。** Lucene 的 `cjk` 分析器、Bleve 的 `cjk_bigram` 都这样做，零依赖，测过也搜得对。主人选 gse：按词切更准，只嵌简体词典后只多 3 MB。

**[wangfenjin/simple](https://github.com/wangfenjin/simple) 这类 SQLite 分词扩展。** 能按拼音搜，但它是 C++ 写的扩展，`modernc.org/sqlite` 是纯 Go，加载不了；换 cgo 的驱动，打包和测试都要多一套工具链。gojieba 同理要 cgo。

**每个来源把自己的工具都直接给 agent。** Nowledge 一家就有 70 多个工具，全给会把 agent 的工具表撑满，也说不清该用哪个；默认只给统一的两个，自带的按来源打开。

**给帮工的记忆工具也取代自动想起。** 那就要靠帮工记得去查，接不了 MCP 的农机就没有记性了；两条都留。

## Acceptance criteria

- `internal/session`、`internal/manager`、`internal/mcp` 和记性页签只经管理器碰记性，不知道有几个来源、存在哪。
- 本地来源：「测试」「提交」「refreshSession」「表名单数」都能搜到对应的记忆，`bm25()` 排在前面的是更相关的；`go test ./internal/memory` 覆盖这几条。
- `CGO_ENABLED=0 go build ./cmd/server` 能编，服务端二进制比改动前多不超过 5 MB。
- 管家能用 `memory_search`、`memory_add`；帮工经 `/mcp` 能查自己的、写自己的，写别的档案被拒。
- 开着一个不应答的来源时，帮工照常开工，日志里有一句跳过了它。
- 接上本机的 Nowledge Mem：帮工收工时它的「记住：」进了 Nowledge，下回开工 `memory_search` 能从 Nowledge 取回（照 `verify-server`）。
- `go vet ./... && go test ./...`、`bun run go:deadcode`、`bun run flutter:check`、`bun run docs:verify` 通过。

## Risks

- 帮工的农机自己也接了同一个记忆服务（EverOS 给 DeepSeek Harness、Hermes 都做了插件）时，农场再写一份就记两遍。设置里每个来源可以按农机排除。
- 发往外面来源的对话里可能有密钥；抹密钥的规则漏了，就会存进别人的库。规则和服务端日志共用一份，并补测试。
- 外面的来源慢，开工就慢；靠第 2 节的超时兜住，超时的值要在真实使用里调。
- gse 的词典取自它的某个版本，升级 gse 时要照第 4 节重新压一份，否则切法和词典对不上。
- 有意放弃的：来源自带的工具默认不给；外面来源没有「快忘了」；EverOS 的 profile、wiki 第一版只读。
