# design：多画板界面与视觉设计稿

`design` 面向多端 UI 界面、状态变体与视觉设计稿，在画布上并排展示桌面、移动、空态与错误态画板，支持关联站内 `design-system` 令牌以及右侧属性控制杆（`props`）实时调参。作品以独立目录存放在 `storage/`（`<storage>/artifact/<id>/`）。

## 目录结构（Directory-per-Artifact）

```text
<storage>/artifact/<id>/
├── manifest.json                 # id、artifactType: "design"、title、可选 designSystemId、frames 索引
├── structure/
│   └── frames/
│       ├── desktop-checkout.json # 桌面端主画板：画布坐标、尺寸、节点树、状态变体与可调 props
│       ├── mobile-checkout.json  # 移动端画板
│       └── empty-state.json      # 边界态画板
└── asset/
    └── hero-product.png          # 界面配图与图标，按相对路径 asset/<name> 引用
```

`manifest.json` 示例：
```json
{
  "id": "art_design_01",
  "artifactType": "design",
  "title": "结账流程多端设计",
  "designSystemId": "art_ds_default",
  "frames": [
    "structure/frames/desktop-checkout.json",
    "structure/frames/mobile-checkout.json"
  ]
}
```

## 多人与多执行会话实时协作规则

1. **按画板文件并行同步（`artifact_collab`）**：每张画板独立存放在 `structure/frames/<id>.json`，多人或多执行会话可同时设计桌面端、移动端或状态变体；通过 `artifact_collab` 按节点稳定 `id` 细粒度合并并落盘，**严禁改一个按钮时重写整张画板或覆盖其他画板**。
2. **来源追踪与视觉方案对比（`artifact_change`）**：每次调色、间距修改与布局调整均记录 `origin`，支持回放评审迭代、按来源撤销某轮改动或分叉备选风格；评审定稿用 `artifact_version` 保存不可变快照。
3. **审阅建议流（`artifact_suggestion`）**：修改用户手调过的文案、配色、间距或删减画板区域时，通过 `artifact_suggestion` 发起审阅建议（或在画布右侧新建对照画板），经用户确认后再落定。
4. **实时在场感知（Presence）**：先查看协作者当前聚焦的画板与选中图层；避开用户正在精修的画板，并行完善其他视口、空态或暗色变体。

## 令牌与工艺准则

- **优先继承 `design-system`**：若 `manifest.json` 关联了 `designSystemId`（或系统已设默认设计体系），颜色、字体、圆角与间距优先引用令牌别名（如 `{color.surface}`、`{radius.md}`），不硬编码零散 hex。
- **可调属性（`props`）**：在画板 JSON 的 `props` 声明关键控制杆（如 `density`、`theme`、`ctaLabel`），方便用户在工作台实时调参验收。
- **真实数据与边界态**：使用贴合业务的真实中文/英文文案与数字，绝不塞 `Lorem ipsum` 或 `Item 1 / Item 2`。

按需延伸阅读：`artifact_type_read({ type: "design", reference: "format" | "craft" })`。
