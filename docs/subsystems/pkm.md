# 笔记

笔记（`Pkm`）是主人的个人知识库，按 PARA 目录组织为 Logseq 式 Markdown 大纲文件并在 `/pkm` 页中查看与编辑；磁盘上的 `.md` 文件是唯一真相，支持与外部编辑器同时使用。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 笔记库目录管理、Markdown 与大纲树互转（`parse` / `print`） | 帮工和管家交付的文档与网页（[稿子](docs/subsystems/artifact.md)） |
| 块操作（`PkmBlockOp`）、双链、标签、块引用、反链与 FTS5 检索 | 档案的经验记忆存储（[记性](docs/subsystems/memory.md)） |
| 闪念捕获、网页剪藏、话题聚类、改名合并、导出与按文件撤销 | 管家与帮工的 `pkm_*` 工具封装（`apps/server/src/tool/pkm.ts`） |
| 行内批注与改写建议（`pkm_comment`）的创建、接受与拒绝 | |

## 在哪

| 位置 | 职责 |
|---|---|
| [`packages/pkm/`](packages/pkm/README.md) | 独立 PKM 与双链大纲纯领域包（`@vibevalley/pkm`）：Logseq 式 Markdown 解析与打印（`markdown.ts`）、PARA 目录映射（`para.ts`）、双链反链与块引用图谱（`graph.ts`）、前端大纲视图与行内切片（`view.ts`）、键盘编辑与补全状态机（`editing.ts`）、多块框选与拖拽（`selection.ts`）、日历日期（`days.ts`）与乐观写入队列（`writer.ts`） |
| `apps/server/src/pkm/pkm.ts` | 文件读写、单写锁、批注表（`pkm_comment`）与撤销表（`pkm_change`） |
| `apps/server/src/pkm/outline.ts`、`ops.ts`、`para.ts`、`graph.ts` | 服务端薄适配层：消费 `@vibevalley/pkm` 并绑定 `memory/recall.ts` 的 `termsList` 分词 |
| `packages/protocol/src/pkm/`、`rules/pkm.ts` | 笔记契约与前后端共用的 `applyBlockOps`、`flatBlocks` |
| `$VIBEVALLEY_HOME/pkm/` | 默认笔记根目录（`00_Inbox`–`04_Archives`、`journals/`、`.pkm/snapshots/`） |
| `apps/web/src/features/pkm/` | 工作台笔记页、大纲编辑器组件（消费 `@vibevalley/pkm`） |

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
  - 所有笔记读写经过同一把信号量锁，采用临时文件原子替换。
  - 每次修改在 `pkm_change` 记录修改前后的全文（保留最近 200 条），`pkm.undo` 每次恢复最新一条变更。
- **Agent 只提改写建议，且强制保留链接**：
  - 帮工和管家通过 `pkm_search`、`pkm_page_get`、`pkm_capture` 和 `pkm_comment_suggest` 访问笔记，不直接覆盖已有块。
  - 改写建议若丢失了原块中的 `[[链接]]` 或 `((引用))`，服务端自动将其补回建议末尾。
  - 主人在界面点击接受后，才替换原块并清除批注标记。
- **前后端共用 `applyBlockOps`**：
  - 页面 `PageWriter` 先在本地同步应用块操作以保持光标连续，再按批调用 `pkm.block.apply`。
  - 编辑器支持多块框选批量缩进/移动/删除，以及圆点手柄拖拽排序（`move_to`）。

## 怎么走

1. **闪念捕获（`pkm.capture`）**：未指定页面时追加到今日日记 `journals/YYYY_MM_DD.md` 并标 `LATER #inbox`；指定页面时追加到该页末尾。
2. **全文检索（`pkm.search`）**：加载或写回时用 `gse` 分词更新 `pkm_term` FTS5 索引；查询结合 `bm25`、整句命中与 PARA 层级权重排序。
3. **改名与合并（`pkm.page.rename`）**：目标页不存在时重命名并记 `alias::`；目标页已存在时合并块并删除旧文件，同时更新全库 `[[旧名]]`。

## 和谁打交道

- **记性（`memory`）**：调用 `termsList` 对中英文块文本分词。
- **管家与工具（`orchestrator`、`tool`）**：管家现状含 `01_Projects` 活跃项目；当轮纯主人发言自动附入最多 3 个相关笔记块。

## 为什么这样

- **Markdown 文件作唯一真相，数据库只存索引、批注与撤销栈**。用户随时可用 Logseq、Obsidian 或 Git 直接管理笔记，无双份存储合并冲突。
- **只在被引用或批注的块上写 `id::`**。避免每行塞满 UUID 污染纯文本阅读，同时保证跨页 `((id))` 引用在外部编辑后依然稳固。

## 还没做的

- 块级图片上传、属性表格视图与多人同时编辑同一页。

## 怎么验证

- `packages/protocol/src/rules/pkm.test.ts`、`apps/server/src/pkm/*.test.ts`：大纲无损往返、按需 `id::`、反链展开、FTS5 权重与批注保留链接测试。
- `apps/web/src/features/pkm/*.test.ts`、`apps/web/test/pkm.spec.ts`：键盘大纲编辑、多块选择与拖拽、搜索跳转与日记视图测试。
