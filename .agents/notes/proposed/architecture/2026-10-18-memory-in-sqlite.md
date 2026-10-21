# Agent Note: 记忆都存在农场的库里：主人画像、管家的记性和干活的经过都进 memory 表

Status: proposed

## Problem

帮工档案的记忆已经在库里：`memory` 表，词由 gse 切好存成 `tsvector`，开工按 `pick` 想起，`memory_search` 按全文索引查，外面的来源（Nowledge、EverOS）并在一起（[记性](docs/subsystems/memory.md)）。还有三样不在：

| 什么 | 现在在哪 | 问题 |
|---|---|---|
| 管家的记性（主人交代的、它自己记的） | 家目录的 `manager/MEMORY.md`（`apps/server/src/agent/brain/memory.ts`），每次请求整份拼进系统提示 | 两套存法、两套增删；记一条就改系统提示的快照（[提示开头不变](docs/subsystems/manager.md)） |
| 关于主人的事实 | 只在管家的 `MEMORY.md` 里 | 帮工拿不到主人的偏好 |
| 一次干活的经过 | 只在事件日志和管家的 `archive/` 里 | `memory_search` 翻不到「上次这事怎么弄的」 |

## Proposal

照 [Hermes](https://github.com/NousResearch/hermes-agent) 的四类记忆，补齐前两类里我们还没有的：

| 种类（`kind`） | 是什么 | 范围 | 谁写 |
|---|---|---|---|
| `profile`（新） | 关于主人的事实和偏好 | 所有 agent 共享（`scope = owner`，`agent` 为空） | 主人、管家、帮工的「记住（主人）：」 |
| `note` | 一个 agent 学到的 | 这个档案 | 已有 |
| `issue` | 做过的活 | 这个档案 | 已有 |
| `episode`（新） | 一次干活的经过：交给它的话、最后的汇报、改了的文件；管家压缩时归档的原文，切成段 | 这个档案（管家是 `manager`） | 收工时、管家压缩时 |

1. **表**：直接改 `apps/server/db/migrations/0001_schema.up.sql` 的 `memory`（不另加迁移，AGENTS.md「不留兼容」）：`kind` 加 `profile`、`episode`；加 `title`、`importance`（0–3）、`labels`；`scope = owner` 时 `agent` 为空（`check`）。全文索引照旧是 `terms_vector` 的 GIN 索引；查询在 `db/queries/memory.sql`。
2. **画像**（`profile`）：管家的会话打开时和每次压缩后取一次，按 `importance` 降序、`created_at` 升序，最多 100 条、4000 字，拼进系统提示；帮工每个会话的第一轮放在输入前面。中途记了新的，下一次压缩前只在最新那条输入里写「记性有更新：……」，提示开头不变。
3. **管家的记性搬进表**：`agent/brain` 加一个可选的 `MemoryStore`（拼进提示的那一块、加一条、改一条、删一条），管家传进去；没传（命令行单独用）照旧用 `MEMORY.md`。`remember` 并进 `memory_add`，加上 `memory_replace`、`memory_remove`（按 id，只认这一次检索或画像里出现过的），取代 `rewrite_memory` 的整份重写。主人交代的变成 `profile`，管家自己记的变成 `agent = manager` 的 `note`。服务端不再读写 `manager/MEMORY.md`。
4. **经过**（`episode`）：每次干活收工时写一条：`title` 是工单标题，`body` 是这一轮交给它的话、最后的汇报、改了的文件名，最多 4000 字；管家压缩时把归档的原文按消息切成不超过 2000 字的段。`memory_search` 带 `kind = episode` 翻，回命中的那一段原文（`memory/excerpt.ts` 的纯函数：第一个命中的词前后各约 80 字），不另调模型总结。`search_archive` 并进来。`episode` 不进开工想起：同一个 Session 的 `issue` 已经是它的总结。
5. **取代**：记一条几乎一样的（沿用 `memoryLikeness` ≥ 0.8），在一个事务里插新的、把旧的 `replaced_by` 设成新的；被取代的不再想起，保留 30 天给页签看前后。
6. **上限**：`note`、`issue` 每个档案 300 条（`memoryKeep`）；`episode` 每个档案留 180 天、最多 2000 条；画像只按字数截。
7. **页签**：管家页的「记性」分成主人画像（共享，标出被截掉的）和管家自己记的；帮工的页签多一列「被取代」。
8. **来源**：画像也从 Nowledge 的 `read_context_bundle`、EverOS 的 user profile 读；EverOS 的经过要整段时从事件日志取。

## Alternatives considered

**管家的记性留在 `MEMORY.md`。** 人能直接打开改；可它和帮工的记忆是两套存法，主人的偏好帮工拿不到，每记一条就改管家的系统提示。页签本来就能看、能写、能删。

**向量检索（embedding）。** 要一个 embedding 模型，本机没有，用服务商的多一份钱；外面的来源本来就做语义检索，本地先做全文检索。

**翻经过时照 Hermes 再调一次 LLM 总结。** 读起来更顺，可每次翻都多花一次钱；同一个 Session 已经有一份 `issue` 总结，再给命中的原文摘录，够用。

**`episode` 也进开工想起。** 想起的预算只有 8 条、1600 字，经过一条就能占满；开工时给总结，要细节让它自己翻。

## Acceptance criteria

- 主人的 `profile` 在每个 agent 的画像里，别的档案的 `note` 搜不到。
- 记一条几乎一样的，旧的被取代、不再被想起，页签看得到前后。
- 帮工收工以后，用它汇报里的一句话 `memory_search`（`kind = episode`）能翻到这一次，回的是原文的那一段；管家归档过的原文同样翻得到。
- 管家的系统提示在两次压缩之间一字不差，中途记了新的也一样（`agent/brain/agent.test.ts` 的同一类测试）。
- 服务端不再读写 `manager/MEMORY.md`。
- `bun run server:check`、`bun run web:check`、`bun run docs:verify` 通过。

## Risks

- 画像共享给所有帮工以后，一条错的偏好会影响每个帮工；页签上画像单独一块，改和删都在那里。
- 取代靠相似度阈值，可能把两条不同的事实当成一条；被取代的保留 30 天，页签能看到、能撤回。
- 已有的 `MEMORY.md` 不搬（「不留兼容」）：升级的机器上，管家原来的记性要主人在页签上重记。
