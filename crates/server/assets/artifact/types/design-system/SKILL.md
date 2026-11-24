# design-system：设计体系与令牌库

`design-system` 定义跨作品复用的色彩、字阶、间距、圆角、阴影与组件规范。设为默认设计体系后，`slides`、`dashboard`、`design`、`prototype` 等视觉作品可直接链接并继承其明暗双主题令牌。作品以独立目录存放在 `storage/`（`<storage>/artifact/<id>/`）。

## 目录结构（Directory-per-Artifact）

```text
<storage>/artifact/<id>/
├── manifest.json                 # id、artifactType: "design-system"、title、version、isDefault
├── structure/
│   ├── tokens.json               # 明暗双主题色彩、字体/字阶、间距、圆角、阴影、边框与动效令牌
│   └── components/
│       ├── button.json           # 组件变体、状态矩阵、令牌绑定与用法规则
│       └── input.json
└── asset/
    └── brand-mark.svg            # 品牌标识、字体样例或视觉规范图，按 asset/<name> 引用
```

`manifest.json` 示例：
```json
{
  "id": "art_ds_01",
  "artifactType": "design-system",
  "title": "Fieldcraft Design System",
  "version": "1.0.0",
  "entry": "structure/tokens.json",
  "components": ["structure/components/button.json", "structure/components/input.json"]
}
```

## 多人与多执行会话实时协作规则

1. **令牌与组件分文件同步（`artifact_collab`）**：基础令牌存于 `structure/tokens.json`，每个组件规范独立存于 `structure/components/<name>.json`。多人或多执行会话可同时补齐不同组件规范或微调不同令牌组，由 `artifact_collab` 细粒度合并并落盘。
2. **来源追踪与版本契约（`artifact_change`）**：每次色值、字阶与组件变体改动均记录 `origin`，支持回放评审与按来源回滚；因为其他作品依赖该体系，正式发布破坏性令牌更新前务必用 `artifact_version` 冻结基线快照。
3. **审阅建议流（`artifact_suggestion`）**：修改用户已锁定的品牌主色、正文字号或基础圆角等核心令牌时，必须通过 `artifact_suggestion` 提交建议并附对比度核对结果，经用户批准后再生效。
4. **实时在场感知（Presence）**：查看协作者当前聚焦的令牌分组或组件文件，避免同时改写同一个组件 JSON。

## 令牌品质铁律

- **WCAG AA 对比度硬约束**：正文色 `ink` 与主背景 `surface`、强调按钮文字与 `accent` 在**浅色与深色两套主题**下对比度均须 ≥ 4.5:1。
- **语义别名优先**：组件规范一律引用 `{color.*}`、`{space.*}`、`{radius.*}` 别名，杜绝在组件里写死原始色值。

按需延伸阅读：`artifact_type_read({ type: "design-system", reference: "format" | "tokens-craft" })`。
