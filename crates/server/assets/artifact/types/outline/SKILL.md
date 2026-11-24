# outline：树状大纲与思维树

`outline` 面向人与执行会话快速梳理要点、层次拆解、会议纪要与脑暴的轻量树状大纲。作品以独立目录存放在 `storage/`（`<storage>/artifact/<id>/`），核心树结构保存在 `structure/outline.json`，附件与插图存放在 `asset/`，强调**短句节点 + 无限缩进 + 折叠聚焦（zoom）**。

## 目录结构（Directory-per-Artifact）

```text
<storage>/artifact/<id>/
├── manifest.json          # id、artifactType: "outline"、title、entry: "structure/outline.json"
├── structure/
│   └── outline.json       # 扁平或嵌套树节点、属性、待办状态、折叠与标签
└── asset/
    └── ref-sketch.png     # 节点附件按相对路径 asset/<name> 引用
```

`structure/outline.json` 核心结构：
```json
{
  "version": 1,
  "rootIds": ["n_goals", "n_risks"],
  "nodes": {
    "n_goals": { "id": "n_goals", "text": "Q3 核心目标", "kind": "heading", "children": ["n_g1"], "props": { "owner": "Core" } },
    "n_g1": { "id": "n_g1", "text": "完成目录化作品存储与实时协作切流", "kind": "todo", "checked": false, "children": [] },
    "n_risks": { "id": "n_risks", "text": "关键风险与对策", "kind": "bullet", "children": [] }
  }
}
```

## 多人与多执行会话实时协作规则

1. **按节点细粒度同步（`artifact_collab`）**：通过统一协作层按稳定节点 `id` 增删改、重排与移动子树；多个参与方同时展开不同分支时自动无冲突合并并同步落盘到 `structure/outline.json`，**严禁整棵树重建覆盖导致节点 ID 漂移**。
2. **来源追踪（`artifact_change`）**：每条节点变更附带 `origin`，支持按轮次撤销某次脑暴扩写、对比历史分支或分叉新大纲；定稿前可用 `artifact_version` 留存快照。
3. **尊重用户手写节点（`artifact_suggestion`）**：当需要改写、合并或删除用户刚写下的节点文本时，提交 `artifact_suggestion` 供用户确认；向分支末尾补充子要点可直接并发追加。
4. **实时在场感知（Presence）**：先查看其他协作者当前聚焦的分支（zoom root）与选中节点，避开用户正在键入的节点，优先在相邻分支展开补充。

## 写作准则

- **一行一事**：每个节点控制在 1 句以内，把原因、证据、子步骤下沉为子节点，方便折叠与聚焦。
- **语义清晰**：常规要点用 `bullet`、可执行项用 `todo`（配 `checked`）、关键引用用 `quote`、结构化属性写入 `props`；需长段叙述或正式 RFC 时改用 `docs`。

按需延伸阅读：`artifact_type_read({ type: "outline", reference: "format" | "craft" })`。
