# 笔记

笔记（`Pkm`）是用户的个人知识库，按 PARA 目录组织为 Logseq 式 Markdown 大纲文件并在 `/pkm` 页中查看与编辑；磁盘上的 `.md` 文件是唯一真相，支持与外部编辑器同时使用。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 笔记库目录管理、Markdown 与大纲树互转（`parse` / `print`） | 帮工和助手交付的文档与网页（[Artifact](docs/subsystems/artifact.md)） |
| 块操作（`PkmBlockOp`）、双链、标签、块引用、反链与全文检索 | 档案的经验记忆存储（[记性](docs/subsystems/memory.md)） |
| 闪念捕获、网页剪藏、话题聚类、改名合并、导出与按文件撤销 | 助手与帮工的 `pkm_*` 工具（`crates/vibevalley-server/src/modules/tool/notes.rs`） |
| 行内批注与改写建议（`pkm_comment`）的创建、接受与拒绝 | |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/mac/ui/features/pkm/` | 客户端大纲编辑器与工作台笔记页：块操作与树折叠（`tree.ts`）、行内切片与大纲视图模型（`outline.ts`）、键盘编辑与补全（`editing.ts`）、多块框选与拖拽（`selection.ts`）、日历日期（`days.ts`、`localDay.ts`）、乐观写入队列（`writer.ts`）与 `PkmPage`/`OutlineEditor` 等 TSX 页面 |
| [笔记服务](crates/vibevalley-server/src/modules/pkm/mod.rs)、[数据库查询](crates/vibevalley-server/src/modules/pkm/sql/queries.sql) | 笔记服务读写并监听 Markdown 文件。sqlc 为批注、全文索引和撤销记录生成 SQLx 查询。 |
| `crates/vibevalley-pkm/src/` | 服务端大纲引擎与单一真相源：Markdown 解析与打印、PARA 目录映射、双链反链与块引用图谱（`graph.rs`）；维护 `crates/vibevalley-pkm/golden` 回归测例 |
| `crates/vibevalley-cli/src/commands/pkm.rs` | `vibevalley pkm ...` |
| `packages/protocol/src/pkm/`、`apps/mac/ui/features/pkm/tree.ts` | 笔记契约与客户端共用的 `applyBlockOps`、`flatBlocks`、`slugOf` |
| `$VIBEVALLEY_WORK_ROOT/pkm/` | 默认笔记根目录（`00_Inbox`–`04_Archives`、`journals/`、`.pkm/snapshots/`） |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`pkm.*`），CLI 命令为 `vibevalley pkm ...`。

## 模型和不变量

- **文件是唯一真相，读写字节幂等**：
  - 一个 `.md` 文件对应一页，所在 PARA 文件夹决定分类层级。
  - 每个 `- ` 开头是一块，两空格缩进表示层级。
  - 块支持 `TODO`/`DOING`/`DONE`/`NOW`/`LATER`/`WAITING`/`CANCELED` 状态与 `[#A]` 优先级。
  - 服务端 `parse` 后再 `print` 输出的字节保持完全一致。
- **按需写入 `id::`，外部修改自动续接 ID**：
  - 仅当块已有 `id::`、被 `((id))` 引用或挂有批注时，才在文件中写出 `id::` 属性。
  - 外部编辑器修改文件触发重读时，未写 `id::` 的块按同层级、同状态与同文本续接原内存 ID（`carryIds`）。
- **单锁串行读写与文件级撤销**：
  - 写回先替换 Markdown 文件。数据库在一笔事务中替换该页的全文索引。若索引写入失败，旧索引仍可读取；下次启动按磁盘正文重建。
  - 所有笔记读写经过同一把信号量锁，采用临时文件原子替换。
  - 每次修改在 `pkm_change` 记录修改前后的全文（保留最近 200 条），`pkm.undo` 每次恢复最新一条变更。
- **Agent 只提改写建议，且强制保留链接**：
  - 帮工和助手通过 `pkm_search`、`pkm_page_get`、`pkm_capture` 和 `pkm_comment_suggest` 访问笔记，不直接覆盖已有块。
  - 改写建议若丢失了原块中的 `[[链接]]` 或 `((引用))`，服务端自动将其补回建议末尾。
  - 用户在界面点击接受后，才替换原块并清除批注标记。
- **前后端共用 `applyBlockOps`**：
  - 页面 `PageWriter` 先在本地同步应用块操作以保持光标连续，再按批调用 `pkm.block.apply`。
  - 编辑器支持多块框选批量缩进/移动/删除，以及圆点手柄拖拽排序（`move_to`）。

## 怎么走

1. **闪念捕获（`pkm.capture`）**：未指定页面时追加到今日日记 `journals/YYYY_MM_DD.md` 并标 `LATER #inbox`；指定页面时追加到该页末尾。
2. **全文检索（`pkm.search`）**：加载或写回时用 `gse` 分词并按块去重合并后，以 `ON CONFLICT(page, block) DO UPDATE` 写进 `pkm_term` 表（`primary key (page, block)`，位于 `server.db`），匹配和打分在 Rust 里做（前缀匹配，照 TS 版 `ts_rank` 的算法）；按分数、整句命中与 PARA 层级权重排序（`crates/vibevalley-server/src/modules/pkm/db.rs`）。
3. **改名与合并（`pkm.page.rename`）**：目标页不存在时重命名并记 `alias::`；目标页已存在时合并块并删除旧文件，同时更新全库 `[[旧名]]`。

## 和谁打交道

- **记性（`memory`）**：共用它的中英文分词（`crates/vibevalley-server/src/modules/memory/gse.rs`）。
- **助手与工具（`orchestrator`、`tool`）**：助手现状含 `01_Projects` 活跃项目；当轮纯用户发言自动附入最多 3 个相关笔记块。

## 为什么这样

- **Markdown 文件作唯一真相，数据库只存索引、批注与撤销栈**。用户随时可用 Logseq、Obsidian 或 Git 直接管理笔记，无双份存储合并冲突。
- **只在被引用或批注的块上写 `id::`**。避免每行塞满 UUID 污染纯文本阅读，同时保证跨页 `((id))` 引用在外部编辑后依然稳固。

## 还没做的

- 块级图片上传、属性表格视图与多人同时编辑同一页。

## 怎么验证

- `apps/mac/ui/features/pkm/tree.test.ts`、`crates/vibevalley-pkm/src/tests.rs`：客户端测 `slugOf` 与 `applyBlockOps`（`nsh/test`），Rust 一侧跑大纲无损往返、按需 `id::`、反链展开与 `crates/vibevalley-pkm/golden` 回归测例。
- `crates/vibevalley-server/tests/pkm.rs`：建页与挪页、读外部编辑器写的、按操作改块保留 id 并撤销、闪念进今天的日记。
- `apps/mac/ui/features/pkm/pkm.test.ts`：编辑、选择与日记视图的纯函数。
- `apps/mac/ui/app/scenarios.test.tsx`：笔记页在多密度虚拟时钟场景下的页面测试（`nsh/test`）。
