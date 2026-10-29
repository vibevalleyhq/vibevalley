# Agent Note: 文档并进产出：一个概念、一个模块

Status: proposed

## Problem

「文档」和「产出」是同一件事的两半：都是主人和帮工留下来、要人看的一篇东西。现在却是两套：

- 两个模块（`doc`、`artifact`）、两组表、两组接口和工具（`doc_get`、`doc_block_*` 和 `artifact_create`、`artifact_version_create`）。
- 两个地方看：左栏的「文档」页只有一起写的块文档，产出只能从对话里的卡片点进 `/artifacts/<id>`，没有一个地方列出全部。
- 文档挂不到频道和工单上，也不出卡片；产出不能一起改，Markdown 的产出只能看。

帮工交一篇调研要选「文档还是产出」，主人找一篇东西要想「它在哪边」。

## Proposal

只留一个概念「产出」（代码里 `artifact`，界面上「产出」），`doc` 模块并进 `artifact`。

- **两种正文**（`ArtifactBody`）：
  - `blocks`：一起写的，按块存、按 op 改（今天的文档，规则、修订、冲突、演示原样搬过来）。
  - `html`：一整页交上来、一版一版换、隔离着看（今天的 HTML 产出，沙箱和响应头不变）。
  - Markdown 不再是单独的一种：交进来的 Markdown 读成块（今天文档的导入），主人和帮工接着都能改。
- **每篇都能挂在频道和工单上**：`channel_id`、`issue` 都可以空（主人在产出页新建的没有）。交给频道的产出照旧以作者的名义说一句带卡片的话，回复卡片就是评论。
- **表**：`artifact`（加 `body`、`seq`，`channel_id` 可空，去掉 `kind`）、`artifact_version`（只给 `html`）、`artifact_block`、`artifact_block_revision`、`artifact_change`（由 `doc_*` 改名）。直接改 `0001_schema.up.sql`，旧库作废。
- **接口**：`artifact.*` 一组：`list`、`get`、`create`（主人：标题，得到空的块产出；作者：`html` 或 `markdown` 的内容或文件）、`delete`（带预演）、`version.create`（只给 `html`）、`content.get`、`blocks.get`、`submit`、`block.create`、`block.update`、`markdown.get`、`demo`。`doc.*` 去掉。
- **工具**：`artifact_create`、`artifact_version_create`、`artifact_get`、`artifact_block_create`、`artifact_block_update`；`doc_*` 去掉。
- **形状**：块那一套不再带 `Doc` 前缀（`DocOp` → `BlockOp`，`DocSubmit` → `BlockSubmit`，`DocAck` → `BlockAck`，`DocSpan`、`DocMarks` → `Span`、`Marks`……），`Document` → `ArtifactBlocks`。
- **页面**：左栏「文档」换成「产出」（`/artifacts`）：左边是全部产出（新建、按在哪、为哪张工单、谁做的），右边打开的那篇，块的就地编辑，网页的隔离着看并列出每一版；对话里的卡片、工单里的「产出」都打开同一页。`/docs` 去掉。
- 然后打磨这一页：照 `docs/style/design.md` 和验收的截图，一处处改到满意。

分三步，一个 PR（[一个 PR 走到底](.agents/notes/README.md)）：服务端和契约 → 页面 → 文档和打磨。

## Alternatives considered

- **只合并页面，服务端留两个模块**：改得少，但「交哪一种」「存在哪边」的分叉还在，帮工的工具也还是两套。主人选了合并到底。
- **叫「文档」**：左栏和代码少改一些；主人要「产出」：强调是交出来要人看的东西。
- **HTML 也拆成块**：块里放不下一整页能跑的 HTML，沙箱只能对整页做。

## Acceptance criteria

- 代码、接口、工具、表、页面、词典里不再有文档（`doc`）这个概念；`stale-names.ts` 拦旧名字。
- 帮工交 Markdown 得到能一起改的块产出，交 HTML 得到隔离着看、有版本的产出，两种都出卡片、挂工单。
- 主人在 `/artifacts` 看到全部产出，新建、写、看每一版、回复、删都在这一页。
- `vp check`、`server:check`、`web:check`、e2e（含 axe 两套主题）、`desktop:test`、`docs:verify` 全过；验收截图浅色、深色各一套。

## Risks

- 改名和搬家的面很大（服务端、契约、页面、工具、测试、文档），中间一步编不过：每一步自己编得过、测得过才提交。
- 帮工的提示和工具描述换了名字，管家的评测样例里有 `doc_*` 的要跟着改；真模型的评测要花钱，不跑，写进 PR 的「没验」。
