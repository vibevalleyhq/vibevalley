# prototype：可运行交互式网页原型

`prototype` 面向可在沙箱内直接点击体验的交互式 HTML/CSS/JS 网页原型（流程验证、微交互试验、组件行为演示、迷你工具）。作品以独立目录存放在 `storage/`（`<storage>/artifact/<id>/`），入口为 `structure/index.html`，样式与脚本分离在 `structure/styles.css` 与 `structure/app.js`，媒体资源放在 `asset/`。

## 目录结构（Directory-per-Artifact）

```text
<storage>/artifact/<id>/
├── manifest.json             # id、artifactType: "prototype"、title、entry: "structure/index.html"
├── structure/
│   ├── index.html            # 语义化页面骨架，引用 ./styles.css 与 ./app.js
│   ├── styles.css            # 样式与明暗主题变量（可继承关联的 design-system 令牌）
│   ├── app.js                # 纯前端交互状态机与 DOM 事件处理（ES Module，免构建）
│   └── data.json             # 可选模拟数据集，保持逻辑与样例数据分离
└── asset/
    └── demo-cover.png        # 相对路径引用：asset/demo-cover.png
```

`manifest.json` 示例：
```json
{
  "id": "art_proto_01",
  "artifactType": "prototype",
  "title": "快捷审批流程交互原型",
  "entry": "structure/index.html",
  "designSystemId": null,
  "viewport": { "width": 1280, "height": 800 }
}
```

## 多人与多执行会话实时协作规则

1. **三层文件解耦并发（`artifact_collab`）**：将结构（`index.html`）、视觉（`styles.css`）、行为（`app.js`）与模拟数据（`data.json`）分离存储；人与多个执行会话可并行调样式、写交互与改文案，通过 `artifact_collab` 细粒度合并并落盘，**严禁改一行样式就整包覆写所有文件**。
2. **来源追踪与分叉试验（`artifact_change`）**：每次代码与文案修订均记录 `origin`，支持回放原型演进、按来源撤销有问题的交互改动或分叉 A/B 交互方案；用户测试前用 `artifact_version` 冻结不可变快照。
3. **审阅建议流（`artifact_suggestion`）**：修改用户亲手调整过的交互文案、视觉风格或核心交互流程时，提交 `artifact_suggestion` 说明改动效果，由用户确认后合入。
4. **实时在场感知（Presence）**：动笔前检查协作者正在编辑的文件（如 `styles.css` vs `app.js`），避免多人同时重写同一函数或 CSS 规则块。

## 沙箱与运行铁律

- **开箱即跑、零构建依赖**：使用原生 HTML5、现代 CSS 与标准 ES Modules，不依赖 Webpack/Vite 编译即可在沙箱中立即打开运行。
- **沙箱安全边界**：所有样式、脚本与图片使用目录内相对路径（`./styles.css`、`./app.js`、`asset/...`）；不向外部未知域名发网络请求，不写 `<meta http-equiv="refresh">`、`<base href>` 或嵌套 `<iframe>`，表单提交由 `app.js` 拦截处理。

按需延伸阅读：`artifact_type_read({ type: "prototype", reference: "format" | "craft" })`。
