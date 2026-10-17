# Agent Note: 记忆都存在 SQLite：一张表、一张全文索引、主人画像和管家的记性也进来

Status: proposed

## Problem

[记性有多个来源](2026-10-18-memory-providers.md)定了本地来源用 SQLite，没写到表、索引、查询和搬家这一层。记忆现在分在两处：

| 什么 | 存在哪 | 怎么进提示 |
|---|---|---|
| 帮工档案的记忆（记下的话、做过的活） | `vibevalley.db` 的 `memory` 表（`migrations/0001_schema.sql`） | 开工时 `pick` 挑 8 条、1600 字 |
| 管家的记性（主人交代的、它自己记的） | 家目录的 `manager/MEMORY.md`（`pkg/agent/memory.go`） | 每次请求整份拼进系统提示，超过 8000 字留最新的 |
| 关于主人的事实 | 只在管家的 `MEMORY.md` 里 | 帮工拿不到 |

两处存法、两套增删、两种拼法；`MEMORY.md` 每记一条就改系统提示，管家每次请求都命不中缓存（[对照 Grok Bot](2026-10-18-always-on-manager.md)第 1 项）；帮工不知道主人的偏好。

另外，主人家里的 `memory` 表有 1 条 `kind` 是 `job`（从 TypeScript 农场导入时的名字），代码记做过的活用的是 `issue`，这一条现在挑不出来。

## Proposal

### 1. 存什么、不存什么

进 SQLite 的是**记忆**：以后还要想起的事实。

| 种类（`kind`） | 是什么 | 范围（`scope`） | 谁写 |
|---|---|---|---|
| `profile` | 关于主人的事实和偏好：「提交信息用中文」「表名用单数」 | `owner`：所有 agent 共享 | 主人、管家、帮工的「记住（主人）：」 |
| `note` | 一个 agent 学到的：「这个项目测试用 `pnpm test`」 | `agent`：这个档案；`project` 为空就是所有项目 | 帮工的「记住：」、`memory_add`、主人替它记 |
| `issue` | 做过的活：工单和最后的结论，一个 Session 一条 | `agent` | 农场收工时写 |

不进的是**上下文和日志**：管家的会话 `manager.jsonl`、压缩时归档的原文 `archive/`、轨迹、帮工的事件。它们是「这一段对话说了什么」，按会话存、按会话读，照旧是文件；`search_archive` 照旧翻它们。

管家的 `MEMORY.md` 没有了：主人交代的变成 `profile`，管家自己记的变成 `agent = manager` 的 `note`。`pkg/agent` 是能单独用的库，它自己的 `MEMORY.md` 留着给命令行用；管家经第 5 节的接口改用这张表。

### 2. 表

一个迁移（`migrations/<序号>_memory.sql`，序号接在当时最后一个后面）把 `memory` 换成新的形状，表名照「模块_概念」，模块是 `internal/memory`：

```sql
CREATE TABLE memory_next (
  id           text primary key,
  scope        text not null check (scope in ('owner', 'agent')),
  agent        text,                -- the profile id; null for scope owner
  kind         text not null check (kind in ('profile', 'note', 'issue')),
  title        text,
  body         text not null,
  terms        text not null default '',   -- body cut by gse, space-joined, lower case (section 3)
  terms_of     integer not null default 0, -- which cut: memory.TermsVersion
  labels       text not null default '[]', -- JSON array
  importance   integer not null default 0 check (importance between 0 and 3),
  project      text,                -- null: every project
  session      text,                -- the Session it came from
  author       text not null check (author in ('owner', 'agent', 'farm')),
  replaced_by  text,                -- the memory that superseded it; never recalled again
  created_at   integer not null,
  updated_at   integer not null,
  recalled     integer not null default 0,
  recalled_at  integer,
  check ((scope = 'owner') = (agent is null))
);
INSERT INTO memory_next (id, scope, agent, kind, body, project, session, author, created_at, updated_at, recalled, recalled_at)
  SELECT id, 'agent', agent, CASE kind WHEN 'job' THEN 'issue' ELSE kind END, body, project, session,
         CASE kind WHEN 'note' THEN 'agent' ELSE 'farm' END, created_at, created_at, recalled, recalled_at
  FROM memory;
DROP TABLE memory;
ALTER TABLE memory_next RENAME TO memory;
CREATE INDEX memory_by_agent ON memory (agent, created_at desc);
CREATE INDEX memory_by_scope ON memory (scope, kind) WHERE replaced_by IS NULL;
CREATE UNIQUE INDEX memory_one_issue ON memory (agent, session) WHERE kind = 'issue';

-- External content: the text lives once, in memory; the index holds only the terms.
CREATE VIRTUAL TABLE memory_term USING fts5(terms, content = 'memory', content_rowid = 'rowid', tokenize = 'unicode61');
-- The rows moved above predate the index: put them in it, or the update trigger's 'delete' finds nothing and the index is corrupt.
INSERT INTO memory_term (memory_term) VALUES ('rebuild');
CREATE TRIGGER memory_term_insert AFTER INSERT ON memory BEGIN
  INSERT INTO memory_term (rowid, terms) VALUES (new.rowid, new.terms);
END;
CREATE TRIGGER memory_term_delete AFTER DELETE ON memory BEGIN
  INSERT INTO memory_term (memory_term, rowid, terms) VALUES ('delete', old.rowid, old.terms);
END;
CREATE TRIGGER memory_term_update AFTER UPDATE OF terms ON memory BEGIN
  INSERT INTO memory_term (memory_term, rowid, terms) VALUES ('delete', old.rowid, old.terms);
  INSERT INTO memory_term (rowid, terms) VALUES (new.rowid, new.terms);
END;
```

- 旧的 `job` 在这里改成 `issue`；旧的两种作者按种类分：`note` 是 agent 记的，`issue` 是农场记的。主人替它记的现在分不出来，算 agent 的。
- 搬过来的行 `terms` 是空的、`terms_of` 是 0：SQL 里切不了中文，由第 3 节开机补。
- 2026-10-18 试过：
  - sqlc v1.31.1 认这张 FTS5 虚表和触发器。查询里要按列 `MATCH`（`memory_term.terms match sqlc.arg(query)`），整表 `MATCH` 它不认；`bm25()` 要包一层 `cast(... as real)`；别名不能叫 `rank`（sqlc 的保留字）。
  - `modernc.org/sqlite` v1.60.1 上增、删、按范围过滤都对；外部内容模式只多四张影子表（`memory_term_data`、`_idx`、`_docsize`、`_config`），文本不存两份。
  - 这段 SQL 在主人家里 `vibevalley.db` 的拷贝上跑过：3 条都在，`job` 成了 `issue`；没有那句 `rebuild` 时，改第一行就报 `database disk image is malformed`，加上以后改、删和 `integrity-check` 都过。

`migrations/names_test.go` 要求每张表有自己的 `queries/<表>.sql`，影子表过不了：它跳过 `sqlite_master.sql` 以 `CREATE VIRTUAL TABLE` 开头的表的影子表（名字是「虚表名_data / _idx / _content / _docsize / _config」），虚表本身仍要有 `queries/memory_term.sql`（可以只有一条 `rebuild`）。

### 3. 切词：gse，版本号管重切

- `internal/memory/terms.go`：`Terms(text) string`，用 gse 的 `CutSearch` 切，只留含字母或数字的词，转小写，空格连起来；查询用 `QueryTerms(text) []string`：`CutSearch` 和 `CutAll` 的并集，每个词加引号，用 `OR` 连。
- 词典只嵌 gse 的简体词典（`data/dict/zh/s_1.txt` 压成 gzip，约 1.9 MB），`LoadDictStr` 加载；不调 `LoadDictEmbed`，它会把日文、繁体、idf 词典全链进来（二进制从 9 MB 到 41 MB；只嵌简体是 12 MB，2026-10-18 量过）。词典文件旁记下取自 gse 的哪个版本，`NOTICE` 写明出处（gse 是 Apache-2.0，词典来自结巴分词，MIT）。
- `const TermsVersion = 1`：切法或词典变了就加一。`memory` 服务开机后在后台把 `terms_of < TermsVersion` 的行重切、写回（触发器同步索引），一批一百行。这不是兼容旧数据：`terms` 是从 `body` 算出来的索引，和重建缓存一样。
- 词典加载约 350 ms，放在开机后的后台；没加载完时写入照旧（`terms` 留空、`terms_of` 为 0，等后台补），检索退回按新旧列出。

### 4. 读：三条路

| 路 | 什么时候 | 查什么 | 给多少 |
|---|---|---|---|
| **画像**（`SystemPromptBlock`） | 管家的会话打开时和每次压缩后；帮工每个会话的第一轮 | `scope = owner`、`kind = profile`、没被取代的，按 `importance` 降序、`created_at` 升序 | 最多 100 条、4000 字（照 Grok Bot 的上限）；超了先丢最不重要、最旧的，管家页标出来 |
| **开工想起**（`Prefetch`） | 帮工每开新的一轮 | 用工单和这一轮的话做查询词，FTS 取前 50 个候选，范围是 `agent = 我` 的 `note` 和 `issue` | 交给第 4 节下面的纯函数排，最多 8 条、1600 字（现在的数） |
| **工具查**（`memory_search`） | 管家和帮工主动调 | 工具给的查询词，加上可选的 `project`、`kind` | 默认 10 条 |

候选取出来以后，排序是 `internal/memory/rank.go` 的一个纯函数，替换现在的 `pick`，黄金数据跟着它：

```
score = -bm25                    (FTS 的相关度，越大越好)
      × 种类：note 2，issue 0.5
      × 地方：这个项目 2，所有项目 1，别的项目 0.5
      × 新旧：exp(-天数 / 30)
      + importance × 0.5
```

- 没有查询词（切出来是空的）时退回按新旧列出，和现在一样能用。
- 做过的活只算这个项目的、最多 3 件（现在的规矩）。
- 想起过的照旧 `recalled + 1`、记下 `recalled_at`。

画像只在会话打开和压缩后取一次，中途记了新的，下一次压缩前不改系统提示，在最新那条输入里写一句「记性有更新：……」，管家的提示开头因此不变。

### 5. 写：一个口子

所有写入经 `memory` 服务，`pkg/agent` 和 `internal/session` 不碰表：

- **记一条**（`memory_add`、帮工的「记住：」、主人替它记、管家的 `remember`）：先算 `terms`，再在同一个范围（`scope`、`agent`、`project`）里找几乎一样的（沿用 `memoryLikeness` ≥ 0.8）。有就在一个事务里插新的、把旧的 `replaced_by` 设成新的 id；没有就只插。帮工的「记住（主人）：」写成 `profile`。
- **做过的活**：照现在的 `KeepJob`，一个 Session 一条，改写。
- **改一条、忘掉一条**：`replace`、`remove` 按 id，取代 `rewrite_memory` 的整份重写（Hermes 的 memory 工具也是 add、replace、remove）。agent 只能改、删它看到过的那几条：工具只认这一次检索或画像里出现过的 id。
- **上限**：每个档案的 `note` 和 `issue` 最多 300 条（现在的 `MemoryKeep`），超了删最久没想起的；被取代的旧行保留 30 天给页签看历史，然后删掉；画像不按条数删，只按第 4 节的字数截。

`pkg/agent` 加一个可选的接口，管家传进去，没传就照旧用 `MEMORY.md`：

```go
// pkg/agent: where an agent's memory lives, when not its home's MEMORY.md.
type MemoryStore interface {
	Block(ctx context.Context) string // the system prompt's 记性, read when the session opens and after a summary
	Add(ctx context.Context, text string) error
	Replace(ctx context.Context, id, text string) error
	Remove(ctx context.Context, id string) error
}
```

### 6. 页签

- 帮工的「记性」页签照旧：手上的活、下回开工会想起的、它记的和你记的、快忘了的；多一列「被取代」，点开看前后。
- 管家页的「记性」页签分成两块：**主人画像**（所有 agent 共享，标出超出 4000 字被截掉的）和管家自己记的。
- 接口照现在的 `memory.*` 分组（[先有能力，再有入口](2026-10-17-capabilities-before-surfaces.md)），`MemoryList` 多出 `profile` 一组；`ManagerMemory` 的 `File` 字段没有了。

### 7. 搬家

- 表里的数据由第 2 节的迁移搬，开机跑迁移时一起做，搬完 `memory` 就是新的形状。
- `MEMORY.md`：主人现在的家里没有（2026-10-18 查过 `~/Library/Application Support/vibevalley` 和 `~/.vibevalley`），不写导入。别的机器上有的，照「不留兼容」，升级前用一个一次性的命令行把每一行读成 `profile`（「主人交代：」开头的）或管家的 `note`，跑完连同命令一起删。
- 搬完以后服务端不读 `manager/MEMORY.md`。

### 步骤

1. 迁移、`names_test` 跳过影子表、`queries/memory.sql` 和 `queries/memory_term.sql`、sqlc 重新生成。
2. `terms.go`（gse 和嵌入的词典）、开机后台补切。
3. `rank.go` 取代 `pick`，重写黄金数据；`Prefetch`、`memory_search` 走 FTS。
4. 画像和管家：`pkg/agent.MemoryStore`、管家改用它、页签。

这四步就是[记性有多个来源](2026-10-18-memory-providers.md)第 1 步「接口和本地来源」里的本地那一半。

## Alternatives considered

**管家的记性留在 `MEMORY.md`。** 人能直接打开改；可它和帮工的记忆是两套存法，主人的偏好帮工拿不到，每记一条就改管家的系统提示。页签本来就能看、能写、能删。

**FTS 用普通表存切好的词、自己算 BM25。** 不依赖 FTS5，可倒排、词频、长度归一都要自己写，还慢；`modernc.org/sqlite` 自带 FTS5 和 `bm25()`。

**FTS 存一份 `body` 的拷贝（不用外部内容）。** 不用触发器，可文本存两份；外部内容加三个触发器，sqlc 和驱动都试过能用。

**在 SQL 迁移里就切好词。** SQLite 里没有中文分词；交给 Go 开机补切，切法升级时同一条路重切。

**向量检索（embedding）。** 要一个 embedding 模型，本机没有，用服务商的多一份钱；外面的来源（Nowledge、EverOS）本来就做语义检索，本地先做全文检索。

**每条记忆一个 Markdown 文件。** 见[记性有多个来源](2026-10-18-memory-providers.md)的同一条。

## Acceptance criteria

- 迁移在一份主人家里 `vibevalley.db` 的拷贝上跑过：3 条都在，那条 `job` 成了 `issue`；`go test ./migrations` 过（含跳过影子表）；开机前留下了库的备份。
- 「测试」「提交」「refreshSession」「表名单数」都搜得到对应的记忆，别的档案的 `note` 搜不到，主人的 `profile` 每个 agent 都在画像里。
- 记一条几乎一样的，旧的被取代，不再被想起；页签看得到前后。
- `TermsVersion` 加一以后开机，所有行被重切，检索结果不变。
- 管家的系统提示在两次压缩之间一字不差，中途记了新的也一样。
- 服务端不再读写 `manager/MEMORY.md`；`CGO_ENABLED=0 go build ./cmd/server` 能编，二进制多不超过 5 MB。
- `go vet ./... && go test ./...`、`bun run go:deadcode`、sqlc 生成的是最新的、`bun run flutter:check`、`bun run docs:verify` 通过。

## Risks

- 迁移改表不能回退。现在开机跑迁移前不备份库，这一条要新加：有待跑的迁移时先把 `vibevalley.db` 复制成 `vibevalley.db.before-<序号>`，迁移在一个事务里，出错时开机失败、库不动。
- 画像共享给所有帮工以后，一条错的偏好会影响每个帮工；页签上画像单独一块，改和删都在那里。
- 词典没加载完时检索退回按新旧列出，开机后头一秒左右的想起会差一点。
- 取代靠相似度阈值，可能把两条不同的事实当成一条；被取代的保留 30 天，页签能看到、能撤回。
- 有意放弃的：本地不做语义检索；`MEMORY.md` 不再是管家记性的来源，只是 `pkg/agent` 单独用时的默认。
