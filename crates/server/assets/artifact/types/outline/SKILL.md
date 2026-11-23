# outline：树状大纲

`outline` 面向人与帮工快速梳理要点、拆解层次、会议纪要与脑暴的轻量单栏树状大纲。存储形态与 `docs` 同为 `body = "blocks"`（`artifact_create` 传 `artifactType: "outline"`，文件后缀约定 `.outline.md`），但强调**短句节点 + 无限缩进嵌套 + 折叠聚焦**，不同于成段叙述的长文 `docs`。

## 核心工作流

1. **创建或导入**：
   - 新建：`artifact_create({ title, artifactType: "outline", content })` 用缩进列表导入初始树，或省略 `content` 先建空大纲再按层级插节点。
   - 导入已有 `.md` / Logseq 笔记：`artifact_outline_import({ markdown, title, filename })`（帮工亦可传 `file` 读工作区 `.md` 文件），自动解析 YAML frontmatter、`key:: value` 属性、缩进树与 `TODO`/`DOING`/`DONE`/`CANCELED` 任务项并建为 `outline`。
2. **用树表达层级（优先嵌套而非大段文字）**：
   - 先用 `artifact_block_list({ id })` 读当前节点树与 `rev`；多节点创建、重排与编辑优先用 `artifact_block_batch({ id, ops })`（支持 `create`+`tempId`、`update`+`baseRev`、`move`、`delete`），单步改动可用 `artifact_block_create` / `update` / `delete`。
   - 顶层节点代表主题或分组；通过 `parentId` 挂接子节点，`afterBlock` 控制同级顺序。
   - 常规要点用 `bulleted`，可执行项用 `todo`（可切换 `checked`），引用原话用 `quote`；需要数据图或迷你交互试算时，可直接挂载 `type: "code"`、`language: "chart"` 或 `"genui"` 的原生渲染块。
3. **尊重用户手写节点**：帮工修改用户手写的节点时，服务端会自动转为待确认建议（`suggestion`），等待用户接受或拒绝。

## 写作准则

- **一行一事**：每个节点控制在 1 句以内，把原因、证据、子步骤下沉为子节点，方便用户折叠与聚焦（zoom）任意分支。
- **结构清晰**：同级节点保持平行粒度；需要展开长段论述、完整方案或正式手册时改用 `docs`。
