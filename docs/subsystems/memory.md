# 记性

每个帮工档案（`Agent`）一份记性（memory），从它派出去的帮工（Session）共用，跨项目、跨重启：帮工每开新的一轮，农场从记性里挑几条放在它的话前面；一轮结束，农场把它汇报里「记住：」开头的行和这件活记下。记性默认存在农场自己的库里，也能同时接外面的记忆服务（Nowledge Mem、EverOS）。农场里不画它，主人在帮工页、管家页的「记性」页签上看和管。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 帮工档案的记性：存、挑、记下、忘掉、上限 | 提醒块怎么拼进输入、干活过程怎么显示「想起了」（`session/rules.ts` 的 `withRecall`，`session/facts.ts`） |
| 开工想起什么（`pick`），和「下回开工会想起什么」的预览 | 什么时候算新的一轮、同一个会话想起过哪些（`session`，存在库里它那一行） |
| 管理器：本地和外面的来源一起读、一起写，合并、去重、超时 | 外面来源的地址和 key 怎么存、怎么校验（`setting`，`settings.json` 的 `memorySources`） |
| `memory_search`、`memory_add` 背后的检索和写入，回给模型的话（`foundText`） | 工具的参数、谁能用、范围由谁定（`apps/server/src/tool`；帮工经 `/mcp`，`mcp`） |
| 管家的 `MEMORY.md` 和旧账 `archive/` 给页面的读写口子 | 管家怎么把 `MEMORY.md` 带进系统提示、`remember` 和 `search_archive` 工具（`agent/brain/memory.ts`；[agents-and-runtimes.md](docs/reference/agents-and-runtimes.md)「管家页」） |
| 送往外面来源之前抹密钥 | 抹密钥的规则本身（`base/redact.ts`，和服务端日志同一份；[设置](docs/subsystems/setting.md)） |
| | 技能书（程序性的「记性」走技能书，[agents-and-runtimes.md](docs/reference/agents-and-runtimes.md)「技能书」） |

## 在哪

- 服务端 `apps/server/src/memory`（`Memories`）：`memory.ts` 对外的方法（管家的和帮工档案的分流）、管家 `MEMORY.md` 的口子；`sources.ts` 几个来源的管理器和一个来源的接口；`memories.ts` 本地来源（库里的读写、读「记住：」）；`recall.ts` 挑法和检索（纯函数）；`terms.ts` 切词，`gse.ts` 是 gse v1.1.0 的中文切法（词典 `data/zh_s.txt.gz` 和 HMM `data/hmm_emit.json.gz`，逐字对上 gse，黄金数据在 `testdata`）；`nowledge.ts`、`everos.ts` 两个外面的来源。
- 表：`memory`（一条记忆一行，`terms` 是切好的词，`terms_vector` 是它的 `tsvector`，GIN 索引 `memory_by_terms`）；查询在 `db/queries/memory.sql`。
- 接口：`memory.list`、`memory.recall`、`memory.create`、`memory.delete`，管家的旧账 `orchestrator.listArchive`、`orchestrator.getArchive`（[capabilities.md](docs/reference/capabilities.md)）。
- 页面：`apps/web/src/pages/Memory.tsx`（帮工页和管家页的记性、管家的旧账）；来源在「设置」的「记性」（`pages/settings/SettingsForm.tsx`）。农场 HUD 的「记忆树」按钮到 `/tree`（`apps/web/src/tree`）：所有档案的记性汇总成一棵树和一片星空，现在用的是假数据（[记忆树](.agents/notes/proposed/feature/2026-10-22-memory-tree.md)）。

## 模型和不变量

- **记性的键是帮工档案的 id**，不是帮工：同一个档案的帮工共用一份；删了档案，记性还在库里，同 id 再建接着用。不进核心状态，页面打开时经接口读。
- **本地的一条是两种之一**：`note`（记下的一句话：帮工汇报里的「记住：」、主人在页签上替它记的、`memory_add` 记的）和 `issue`（做过的活：工单前 100 字 + 「 → 」+ 最后一轮的结论前 200 字，没做成的写「没做成：」）。`project` 为空是所有项目的。每条记着谁写的（`author`）：`owner` 是主人在页签上记的，`agent` 是帮工自己（「记住：」或它的 `memory_add`，带着是哪个 Session），`orchestrator` 是管家替它记的，`system` 是服务端记下的做过的活；页签照它写「你记的」「某某 记的」「管家替它记的」。外面来源和管家的 `MEMORY.md` 不知道是谁写的，`author` 为空。做过的活一个 Session 一条，每轮改写（`memory_one_issue` 唯一索引）。表里的 `scope = owner`、`profile`、`episode`、`replaced_by`、`title`、`labels`、`importance` 是给[记忆都存在 SQLite](.agents/notes/proposed/architecture/2026-10-18-memory-in-sqlite.md)留的，代码现在只写 `scope = agent` 的 `note`、`issue`，读时跳过 `replaced_by` 不为空的和不认识的种类。
- **上限**：每个档案最多 300 条（`memoryKeep`），超了先删最久没用的（最后想起的时间，没想起过按写下的时间，`nextForgotten`）；页签上离上限不到 10 条时把最先会删的标成 `fading`，和真删的顺序是同一个函数。一句话最多 300 个字符（UTF-16），一轮最多读 5 条「记住：」。
- **一轮的笔记、做过的活和超额的清理在一个事务里**，失败不留下半份。
- **几乎一样的不重复记**：同一个范围（同项目或都是所有项目）里已有一样的，或词的重合度（`memoryLikeness`，交集比并集）≥ 0.8 的，就不记；提不出词的不同短句重合度是 0，分别留着。
- **词**（`terms.ts`）：中文用 gse 的 `cutSearch` 和 `cutAll` 的并集（「表名单数」两种切法都有，「单数」也算），只留两个字以上含汉字的词；英文、数字、路径、版本号按整词（`db/migrations`、`v1.2.3` 各是一个词），小写；去掉停用词。每条写入时切好存进 `terms` 列，`terms_of` 记是第几版切法；切法或词典变了就把 `termsVersion` 加一，本地来源开机后在后台把 `terms_of` 旧的一批一百行重切。词典第一次用时加载。
- **挑法是纯函数，不调模型**（`recall.ts` 的 `pick`）：
  - 跳过这个会话想起过的、和这个 Session 自己写的；做过的活只算这个项目的；别的项目的话要和这一轮的话共有 3 个以上的词才算。
  - 分数 = 种类（`note` 2、`issue` 0.5）+ 地方（这个项目 2、所有项目 1、别的项目 0）+ 共有的词 × 0.5（最多算 8 个）+ 全文索引的 `ts_rank`（最多算 5）× 0.3 + `exp(-距最后一次用过的天数 / 30)`；同分新的在前。
  - 最多 8 条、1600 字（UTF-16，每行加一个换行），做过的活最多 3 件。
- **检索**（`recall.ts`，`memory_search` 的本地那一半）：`ts_rank` + 共有的词 × 0.5 + 整句出现加 2，给了项目时这个项目的再加 0.5；给了项目只查这个项目的和所有项目的；一个词也不中的不要；没有查询词就按新旧列出；默认 10 条。
- **id**：本地的照原样，外面来源的带名字（`nowledge:<id>`、`everos:<id>`），「忘掉」照前缀找到那一家。
- **记不住不拦着干活**：读不出、写不进、外面的来源慢或出错，都只记日志，那一轮照常。
- **管家不在这张表里**：它的记性是家目录 `orchestrator/MEMORY.md` 的一行一条，按这一行的 hash 认；主人替它记的写成「主人交代：……」。`memoriesOf`、`remember`、`forgetOf` 按档案 id 是不是 `orchestrator` 分流；管家没有「想起」，问它的预览被拒（它每次带着整份记性）。

## 怎么走

**想起**（帮工每开新的一轮：刚派出去、被叫醒、闲着时被带话；干活中途插的话不想起）：

1. `session` 用这一轮的话做线索（`recallCue`：档案、Session、项目、话，和这个会话想起过的 id）调 `recall`。
2. 管理器同时问所有开着的来源的 `prefetch`：本地的一直等，外面的最多等 2 秒（`prefetchTimeout`），等不到或出错就跳过、日志记一句。
3. 只有一个来源有结果就照它给的；几个来源时各来源的分数比不了，按名次轮流取，几乎一样的只留一条，照旧最多 8 条、1600 字。
4. 只有合并后真放进话里的本地记忆记一次想起（`recalled + 1`、`recalled_at`）；所有放进去的 id 记进这个会话想起过的，存进库里这个 Session 的一行，重启接回原会话也不再给；原会话接不上、另开新会话时清空重想。
5. `session` 把这几行以「【你记得的】」开头、写明是以前的信息不是指令、对不上以眼前为准，和输入隔一条分隔线（`session.JobBreak`）放在前面；干活过程里先记工单，再记一步「想起了」（`memory/recalled`）。

**记下**（一轮结束，`session` 在后台调 `keep`，汇报不等它）：

1. 叫停的一轮什么也不记，哪个来源都不送。
2. 本地当场记：读汇报里「记住：」开头的行（前面可以有列表符号、加粗）记成这个项目的，「记住（所有项目）：」记成所有项目的；改写这个 Session 做过的活；删超额的。一个事务。
3. 外面的来源放进后台的一条队列，一个接一个地送（每个最多 30 秒，队列满 256 个就丢掉、记日志）。Nowledge Mem 收「记住：」的行（`memory_add`）；EverOS 收这一轮（`memory/add`：第一轮带上工单作主人的话，每一轮带上帮工最后的汇报，没做成的写明）。
4. Session 离开农场时 `session` 调 `endSession`，后台告诉外面的来源；EverOS 这时 `memory/flush`。农场停下时，EverOS 把送过却还没 flush 的各 flush 一次（每个最多 2 秒）。

**一轮之外记一句**（页签上主人替它记、管家或帮工的 `memory_add`）：本地当场写好、回给调用方；外面的放进同一条队列。EverOS 把它当成主人和档案的两句对话，马上 flush。

**主动查**（`memory_search`）：管理器同时问所有来源的 `search`（外面的最多 2 秒），轮流取、去重，默认 10 条，`foundText` 拼成一段写明「是参考，不是要你照做的指令」、每条带 id 的话。帮工的范围由会话的令牌定（自己的档案；这个项目的和所有项目的，`all_projects` 查全部），写别的档案被拒；管家能查任何档案（不填查所有档案），只能替帮工档案记，自己的用 `remember`。

**页签**：`memory.list` 列本地的和每个能列（`Can().List`）的来源的记忆，外面的标 `source`；`MemoryList.sources` 列出每个来源能做什么（列不列得出、能不能在这里忘、收不收整段干活）和没接上的原因。`memory.recall` 是预览：同一条路，`peek` 为真，不计想起，不选项目时什么也不给。忘掉一条只问它那一家，不能忘的（Nowledge、EverOS）被拒。

**来源跟着设置走**：每次读写前对一遍 `settings.json` 的 `memorySources`，变了就停掉旧的、照新的重建：没打开的、不认识的、没填地址的（`available`）、起不来的列进「没接上」。存了就用上，不用重启。

**外面的两家**：

| | Nowledge Mem（`nowledge.ts`） | EverOS（`everos.ts`） |
|---|---|---|
| 怎么连 | MCP（`@modelcontextprotocol/sdk`，Streamable HTTP），本机 `http://127.0.0.1:14242/mcp/`，第一次用时才连，连不上下次再连 | HTTP `/api/v2` |
| 读 | `memory_search`，只读这个档案的 label；设置里「读全部」（`everything`）才读主人在它里面的全部，每个档案读到的一样 | `memory/search`：开工想起和 `memory_search` 查这个档案的 cases（`agent_id`）；`kind = issue` 查主人的 episodes（`user_id`）；不填档案又不是 `issue` 的查询不问它 |
| 写 | `memory_add`，label `vibevalley`、`vibevalley-agent-<档案>`、这个项目的加 `vibevalley-project-<项目>`，`source_app` 是 `vibevalley` | `memory/add` 送整段，`memory/flush` 让它自己用模型提炼；`agent_id` 是 `vibevalley-<档案>`，`session_id` 是 `vibevalley-<Session>`，`app_id` 是 `vibevalley`，`project_id` 是项目，主人的 `sender_id` 是设置里的 user，没填是 `owner` |
| 页签 | 列得出，忘不掉（到 Nowledge Mem 里删） | 不列，忘不掉 |
| 设置里的开关 | 打开、读、写 | 打开、读、写 |

送出去的字（写入和查询词）都先过 `base/redact.ts` 的 `redact`。

## 和谁打交道

- **帮工（`session`）**：调 `recall`（新的一轮前）、`keep`（一轮结束，`finishedRun`）、`endSession`（Session 离开，`endedSession`）；记性存在哪、有几个来源，`session` 不知道。
- **工具（`tool`、`mcp`）**：管家和帮工的 `memory_search`、`memory_add` 调 `search`、`remember`，回话用 `foundText`。
- **设置（`setting`）**：管理器每次用时读记性的来源设置。
- **帮工档案（`agent`）**：不填档案的检索要列出所有档案。
- **管家（`agent/brain`）**：管家页经 `Memories` 读写 `MEMORY.md`（`readMemory`、`remember`、`forgetLine`）、列和搜旧账（`archiveFiles`、`readArchive`、`searchArchive`），和管家自己的工具用同一套；`orchestratorHome` 给出管家的家目录，`orchestrator` 也用它。
- **处理函数（`handlers.ts`）**：`memory.*`、`orchestrator.listArchive`、`orchestrator.getArchive` 只转发到 `Memories`。

## 为什么这样

- **记性跟着档案，不跟着帮工，不进核心状态。** 帮工收工就没了，记下的留不到下次派出去的同一个档案；核心状态每个快照都要带上所有档案的记性，又只有页签用得到。
- **每一轮开头放在输入前面，不放系统提示。** 系统提示只在会话打开时给一次，被叫醒、接着原会话的帮工拿不到新记下的。
- **帮工自己写「记住：」，农场不另调模型总结。** 另调一次每轮多花一次钱，还要选模型、管额度；帮工本来就在写汇报，记什么也由最了解这一轮的它来定。做过的活由农场记，不靠它写。
- **挑法是纯函数，页签的预览问服务端。** 不调模型、可以用黄金数据测；预览和开工走同一条路（只是不计想起），页面里没有第二份挑法。
- **自动想起和工具两条都留。** 只给工具就要靠帮工记得去查，接不了 MCP 的农机就没有记性；只给自动想起，干到一半想查没有办法。
- **中文用 gse 的切法，只带简体词典。** Postgres 自带的分词把一串中文当一个词；两个字一组（CJK bigram）零依赖，但切得不准；装 zhparser 一类的扩展 PGlite 带不了。所以词在写入前由 `gse.ts` 切好（照 gse v1.1.0 的词典和 HMM，逐字对上它），存成 `tsvector`，每个词原样当一个词位。只带简体那一份词典：日文、繁体、idf 词典用不上。英文和代码不交给 gse：它把 `v1.2.3` 切成几段，一个版本号就算三个共有的词。
- **全文索引用 `tsvector` 和 GIN。** 自己存词、算分要自己写倒排和长度归一；`terms_vector` 由库从 `terms` 算出，`ts_rank` 给分。`terms` 是从 `body` 算出来的索引，`termsVersion` 变了就重切，和重建缓存一样，不算兼容旧数据。
- **多个来源同时开，接口照 Hermes 的 `memoryProvider`。** Hermes 只许开一个外接来源，因为每个来源都往 agent 身上加自己的工具；这里对 agent 只给统一的两个工具，来源多了工具不变，而主人 Nowledge 和 EverOS 都要。也没选「只写一个目标、其余只读」：EverOS 要整段对话自己提炼，不写它就什么都没有，重复交给读时去重。接口里只放现在有人调的方法，其余的等第一个调用的人。
- **合并按名次轮流取，不按分数。** 本地的是名次，Nowledge 的是 0 到 1 的相关度，比不了。
- **外面的读最多等 2 秒，写在后台排队。** 开工等它就是主人在等；收工和记一条不等外面的服务，送不成只记日志。只给真放进话里的本地记忆记想起，被合并挤掉的不算。
- **来源自带的工具不给 agent。** Nowledge 一家就有 70 多个工具，全给会撑满工具表，也说不清该用哪个。
- **本地不用 Markdown 文件。** 字段多一行写不下，几个帮工同时收工没有事务，检索还得另建索引；页签本来就能看、能写、能删。
- **管家的记性留在 `MEMORY.md`，页面直接读写那个文件。** 管家的 `remember`、`rewrite_memory` 和系统提示都写死了这个文件，`brain` 又是能单独用的命令行 agent；搬进表要先改它的记性模型（[记忆都存在库里](.agents/notes/proposed/architecture/2026-10-18-memory-in-sqlite.md)）。
- **Nowledge 用 label 隔开档案，不用 `agent_id`；只加不删。** 它不认识的 `agent_id` 退回默认空间，隔不开；它是主人自己的知识库，农场只往里加。EverOS 的 `agent_id`、`session_id` 带 `vibevalley-` 前缀：同一个 EverOS 里还有别的应用的 agent，Session 编号也只在一个家目录里不重。
- **送出去先抹密钥，和服务端日志同一份规则。** 帮工的汇报里可能有 key，漏了就存进别人的库；规则只有一份，修一处两边都好。

## 还没做的

- 主人画像（`profile`）、管家的记性搬进表、干活的经过（`episode`）、`memory_replace`、`memory_remove`、搜索的种类交给模型、全文索引先取候选再排、画像拼进系统提示（`systemPromptBlock`）、来源自带的工具和按农机排除来源、EverOS 收整段干活（现在只有工单和最后的汇报）、对真的 Nowledge Mem 验证写入：[记忆都存在库里](.agents/notes/proposed/architecture/2026-10-18-memory-in-sqlite.md)。

## 怎么验证

- `apps/server/src/memory/memory.test.ts`：一轮的「记住：」怎么读；干活记下、想起、计数，笔记写下和忘掉；管家的 `MEMORY.md`（每一行、主人交代的、日期、忘掉）和旧账；预览挑而不计、最久没用的标 `fading`；全文索引跟着表走；提不出词的不同短句不算重复；做过的活写不进时这一轮的笔记退回；一轮里几乎一样的只记一次；标成 `fading` 的就是会删的。
- `memory/recall.test.ts`：黄金数据（词、每条的相关度、挑出来的）；太常见的词不算；别的项目的笔记要共有词才算；做过的活只算这个项目的、最多三件、不算自己这个会话的；行的写法和太多时先删哪条；一轮说的「记住：」。
- `memory/terms.test.ts`：词照 gse 的黄金数据；英文和代码按整词。
- `memory/providers.test.ts`：一个来源的想起和预览一样；慢的来源不拖住一轮或一次检索；别的来源的 id 带名字；一个来源记不住不影响别的；来源跟着设置；只有告诉了的才算想起；忘不掉的来源不问；合并按名次在预算里取最好的、不重复；检索先给自己档案最好的，轮流问每个来源。
- `memory/outside.test.ts`（本机假的 Nowledge 和 EverOS）：一轮的笔记到 Nowledge 再读回来；Nowledge 只在说了时读全部、写；不答的 Nowledge 跳过；EverOS 收整段、会话结束时提炼；一轮之外的笔记马上提炼；农场停下时告诉 EverOS 剩下的。
- `src/flows/memory.test.ts`：帮工写「记住：」，同一个档案的下一个帮工在同一个项目里想起，别的项目只想起所有项目的，别的档案什么也想不起，新写的才再提；重启后接着原来的会话不再提一遍。
- `mcp/mcp.test.ts`：帮工只查、只写自己的记性。
- 页面：`apps/web/test/agents.spec.ts`、`orchestrator.spec.ts`（记性和旧账）、`settings.spec.ts`（记性的来源）。
