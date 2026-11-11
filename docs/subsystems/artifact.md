# Artifact

Artifact（`Artifact`）是用户、助手和帮工共创或交付的文档产物，在 `/artifacts` 页和聊天旁栏 `ArtifactCanvas` 中查看与编辑。正文分两种：
- **协作块文档（`blocks`）**：由段落、标题、列表、待办、代码等块组成，按 `BlockOp` 协同修改，服务端为唯一权威。
- **网页 Artifact（`html`）**：完整单页 HTML，按版本不可变存储，在严格沙箱 `iframe` 中隔离展示并支持划词改字。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| Artifact 元数据、频道卡片投递、块序列与 HTML 版本内容存储 | 对话中的卡片回复与唤醒（[频道](docs/subsystems/channel.md)） |
| 块模型、分数顺序键（`keyBetween`）、`BlockOp` 管线、块修订与改写建议（`Suggestion`） | 消息普通文件附件（[频道](docs/subsystems/channel.md)） |
| Markdown 与块互转、HTML 白名单检查与划词源码替换（`artifact.html.edit`） | 帮工 `/mcp` 鉴权与工单生命周期（[帮工](docs/subsystems/session.md)、[工单](docs/subsystems/issue.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| [`packages/artifact/`](packages/artifact/README.md) | 独立 Artifact 纯领域包（`@vibevalley/artifact`）：块状态机 `Page` 与码点切分（`ops.ts`）、Markdown 互转（`markdown.ts`）、HTML CSP 响应头与 `parse5` 白名单检查及划词改字（`html.ts`）、前端块跨度计算与协同编辑器状态机（`blocks.ts`、`editor.ts`） |
| `apps/server/src/modules/artifact/artifact.ts`、`blocks.ts` | Artifact 增删改查、块与建议的持久化、HTML 每一稿存成附件（[附件](docs/subsystems/attachment.md)）与频道卡片发送 |
| `apps/server/src/modules/artifact/ops.ts`、`markdown.ts`、`policy.ts`、`check.ts`、`edit.ts`、`shell.ts` | 服务端薄消费出口（转发 `@vibevalley/artifact`） |
| `packages/protocol/src/rules/order.ts`、`display.ts` | 前后端共用的分数顺序键 `keyBetween` 与沙箱常量 `htmlSandbox` |
| 表 `artifact`、`artifact_version`、`artifact_block`、`artifact_block_revision`、`artifact_change`、`artifact_suggestion` | Artifact、HTML 版本、块、块修订、操作批次与改写建议表 |
| `apps/web/src/features/artifact/` | `ArtifactsPage.tsx`、`ArtifactCanvas.tsx`、`BlocksView.tsx` 及消费 `@vibevalley/artifact` 的薄层适配 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`artifact.*` 及 `GET /api/v1/artifact/<id>/<version>`）。

## 模型和不变量

### 网页 Artifact（`html`）

- **每一稿是一个附件，版本不可变**：单版上限 5MB，字节经 `Attachment.keep` 存一次，`artifact_version.attachment_id` 指向它；提交新版追加 `artifact_version` 记录，不覆盖旧版；删掉 Artifact 不删附件。
- **双层沙箱隔离**：`GET /api/v1/artifact/<id>/<version>` 响应头携带严格 CSP（`sandbox` 不含 `allow-same-origin`，`connect-src 'none'`），前端 `iframe` 同步设 `sandbox={htmlSandbox}`。
- **提交前静态白名单检查（`check.ts`）**：仅放行 `cdn.jsdelivr.net`、`cdnjs.cloudflare.com`、`fonts.googleapis.com`、`fonts.gstatic.com`，且媒体必须内联為 `data:` 或 `blob:`；含表外外链、表单提交或嵌套页面的直接拒绝并报错行号。
- **怎么看（`display`）**：网页 Artifact 带 `display`：`page`（整页，没有约定）、`slides`、`motion`，建的时候定（不填是 `page`），`artifact.update` 能改，一稿不变只换看法；一起写的没有这一项。
- **外壳和消息约定（`@vibevalley/artifact/shell`）**：工作台看一稿时请求 `?shell=1&display=…&theme=…`，服务端在页面后面接上主题变量（`--vv-page`、`--vv-ink`…，和 `style.css` 的取值一致）、划词脚本和 `vv` 运行时；样式用 `:where()`，页面自己写的总是赢。运行时只对父窗口说话、只听父窗口：页面报 `ready`（种类、页数和每页的标题、备注，或时长）和 `at`（第几页、第几秒），外壳发 `goto`、`seek`、`play`、`pause`。两头都按 `HtmlShellMessage`、`HtmlShellCommand` 的 Schema 认，不认的丢掉；页面的话只改外壳显示的东西，不能让工作台做框外的事。显示和主题写在地址里，因为一稿的响应永久缓存。
- **幻灯片（`display: "slides"`）**：一页一个顶层 `<section>`，备注写在 `<aside class="notes">`，版式 class 有 `title`、`two-col`、`image`、`quote`。运行时按 1280×720 排一页、缩放到框里，`?at=` 打开在某一页，`?still=1` 是缩略图（不收键盘和点击），自己处理 ←/→、空格、Home/End 和点击翻页，报每页的标题和备注。外壳（`SlidesControls`）给上一页、下一页、缩略图条、全屏放映、演讲者视图（`/present`，当前页、下一页、备注、计时）和存成 PDF；工作台的标签页和演讲者视图经 `BroadcastChannel` 互相跟着翻。存成 PDF 是新开一个 `?print=1` 的页面：只有它的 CSP 多一个 `allow-modals`，好让页面自己调打印，打印时每页一张纸。写法给模型的在工具描述（`display`）和助手的 `slides` skill（`apps/server/src/modules/orchestrator/skills/slides/SKILL.md`，带模板）。
- **划词源码替换（`artifact.html.edit`）**：预览挂载 `?shell=1` 外壳，划词生成选中文本及前后各 32 字的 `HtmlAnchor`；服务端在最新版源码中唯一匹配并替换该处转义字节存为新版，跨标签或有歧义则拒绝。

### 协作块文档（`blocks`）

- **扁平块表 + 分数索引排序**：每块含客户端生成的 UUID `id`、`parentId` 和不以 `0` 结尾的 base62 顺序键 `orderKey`，同级按 `(orderKey, id)` 排序；`split_block.offset` 按 Unicode 码点计算。
- **单写锁批处理与幂等 `batchId`**：`artifact.submit` 在单锁单事务内按序施加 `BlockOp[]`、递增文档 `seq` 与块 `rev` 并返回 `BlockAck`；相同 `batchId` 重发直接返回首次结果。
- **按 `baseRev` 与文本比对判冲突**：`update_text` 与 `split_block` 携带 `baseRev`；若 `baseRev` 落后但该块文本未变（仅改过勾选或属性）仍正常施加，文本已变则返回 `conflict` 并将提交文本存为 `conflict` 修订。
- **用户写过的块受保护（`Suggestion`）**：agent 对 `updatedBy = "owner"` 的块调修改或删除时，服务端不改原块，而是记一条带 `baseRev` 的 `Suggestion`；用户接受时若块当前 `rev` 仍等于 `baseRev` 才应用，否则作废。
- **实时推送与拼字保护**：块与建议经 `/api/v1/rpc` 的 `artifact.follow` 实时推送；前端 `BlockEditor` 对正聚焦、正处于输入法拼字或有待发改动的块保留本地文本，失焦且在途批次落定后再应用远端更新。

## 怎么走

**创建与交付 Artifact**

1. 帮工或助手调用 `artifact_create`（传入 `html` 或 `markdown` 正文，或工作目录内相对路径 `file`）。
2. 服务端校验内容（`html` 过 `check.ts`，`markdown` 转为初始 `BlockInput[]`），在对应工单串或频道发出带 `ArtifactCard` 的消息并落库。
3. 用户在 `/artifacts` 点「新建」直接创建空的 `blocks` Artifact，不发频道消息。

**块协同编辑与带话**

1. 用户输入时，本地每 500ms（持续输入最长 2 秒）或回车/失焦时将积压的 `BlockOp` 提交 `artifact.submit`；帮工调 `artifact_block_create|update|delete` 走同一管线。
2. 在聊天旁栏点块上的「带话」将其加入输入框，发送时服务端记录块 ID、引用版本与当前文本供帮工定位。

## 和谁打交道

- **频道（`channel`）**：调用 `Channel.announce` 发 Artifact 卡片；在消息中记录被引用的块快照。
- **工具（`tool`、`mcp`）**：向助手和帮工暴露 `artifact_*` 工具，自动绑定会话工单与档案身份。
- **「连接到本机」（`lan`）**：放行配对设备访问 `GET /api/v1/artifact/<id>/<version>`。

## 为什么这样

- **统一「文档」与「Artifact」，Markdown 入库即转块**：只读交付物与协作文档集中管理，Markdown 交上来即可逐段协同修改，无需维护两套工具。
- **HTML 走独立路由 + CSP 沙箱 + 提交前静态检查**：不用 `srcdoc`，使 `iframe` 与新标签页共享响应头隔离；提交前拦截外链让帮工当场修好，避免用户打开破损页面。
- **按块操作 + 服务端定序，不上 CRDT**：文档协作以段落分工为主，按块 `baseRev` 判冲突并配合用户块 `Suggestion` 机制，用纯函数即可杜绝静默覆盖。
- **网页种类保持 HTML 优先加轻量外壳约定，不用自定义 Markdown/JSON 渲染器**：帮工写 HTML 表达力不受渲染器限制，外壳只通过 `postMessage` 读取页数、备注或时间轴并提供翻页、放映、打印和录制控制；放弃无约定自建翻页（每篇写法不一且外壳无法统一导出）。

## 还没做的

- 网页 Artifact 动画时间轴（`display: "motion"`）与导出视频入素材库：[网页 Artifact 的 motion 动画时间轴与导出视频](.agents/notes/proposed/feature/2026-11-10-html-artifact-kinds.md)。
- 网页 Artifact 元素锚点、锚点评论标记与自适应高度回报：[网页 Artifact 的元素锚点、锚点评论与高度回报](.agents/notes/proposed/feature/2026-11-04-html-artifact-display.md)。
- 父子工单分节绑定与按节确认定稿：[几个帮工同时写一篇文章](.agents/notes/proposed/feature/2026-10-20-block-editor-ux.md)。
- 块编辑器在线光标、块内三方合并（`merged`）与修订历史找回。

## 怎么验证

- `apps/server/src/modules/artifact/policy.test.ts`、`check.test.ts`、`edit.test.ts`、`http/artifact.test.ts`：CSP 响应头、白名单拦截、划词源码替换与 `?shell=1` 注入测试。
- `apps/server/src/modules/artifact/blocks.rules.test.ts`、`blocks.test.ts`、`artifact.test.ts`：顺序键、Markdown 往返、`batchId` 幂等、`baseRev` 冲突、`Suggestion` 与 `artifact.follow` 测试。
- `apps/web/test/artifact.spec.ts`、`artifact-blocks.spec.ts`：浏览器沙箱隔离、划词改字、块编辑与建议接受端到端测试。
- `packages/artifact/src/artifact.test.ts`：外壳消息只认约定里的形状、主题变量和运行时接在页面后面；`apps/web/test/slides.spec.ts`：幻灯片按控件、缩略图和键盘翻页，演讲者视图互相跟着翻、显示备注，打印时一页一张。
