# Artifact

Artifact（`Artifact`）是用户、助手和帮工共创或交付的文档与交互作品，在 `/artifacts` 页和聊天旁栏 `ArtifactCanvas` 中查看与双向编辑。底层按存储形态（`body`）分三种，并在此之上提供七种结构化创作类型（`ArtifactType`）：

- **协作块文档（`blocks`，对应 `artifactType = "docs"`）**：由段落、标题、列表、待办、代码等块组成，按 `BlockOp` 协同修改，服务端为唯一权威，支持导出 Markdown。
- **结构化多条目作品（`store`）**：由带路径与修订号 `rev` 的命名条目（`artifact_entry`：`text`、`json`、`asset`）组成，承载六种专用创作运行时——**幻灯片（`slides`）**、**数据看板（`dashboard`）**、**动态短片（`motion`）**、**无限白板（`whiteboard`）**、**界面画板（`design`）** 与 **设计体系（`design-system`）**。
- **单页网页（`html`）**：完整单页 HTML，按版本不可变存储，支持 `display`（`page`、`slides`、`motion`），在严格沙箱 `iframe` 中隔离展示并支持划词改字与时间轴录屏导出。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| Artifact 元数据、默认设计体系标记（`isDefault`）、频道卡片投递、块序列、Store 条目与 HTML 版本存储 | 对话中的卡片回复与唤醒（[频道](docs/subsystems/channel.md)） |
| 七种 `ArtifactType` 的渐进披露技能指南（`artifact.type.list`、`artifact.type.read`）与默认令牌注入 | 消息普通文件附件与素材库管理（[频道](docs/subsystems/channel.md)、[媒体与素材库](docs/subsystems/media.md)） |
| 块模型、`BlockOp` 管线、修订与建议（`Suggestion`）；Store 条目 `ifRev` 乐观并发、JSON Merge Patch 与 SSE 增量同步 | 帮工 `/mcp` 鉴权与工单生命周期（[帮工](docs/subsystems/session.md)、[工单](docs/subsystems/issue.md)） |
| Markdown 与块互转、HTML/SVG 白名单净化、划词替换（`artifact.html.edit`）与沙箱视图拼装（`GET /api/v1/artifact/<id>/view`） | 助手与帮工提示拼装本身（[会话](docs/subsystems/session.md)、[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| [`packages/artifact/`](packages/artifact/README.md) | 独立 Artifact 纯领域包（`@vibevalley/artifact`）：块状态机 `Page`（`ops.ts`）、Markdown 互转（`markdown.ts`）、HTML CSP 与白名单检查（`html.ts`）、外壳与 `vv.timeline` 录屏运行时（`shell.ts`）、Store 校验与 JSON Merge Patch（`store.ts`）、设计令牌编译与对比度计算（`tokens.ts`）、Store 沙箱渲染器与 SVG/`.dc.html` 处理（`viewers.ts`）、初始模板（`starters.ts`）及块编辑器（`blocks.ts`、`editor.ts`） |
| `apps/server/src/modules/artifact/` | `artifact.ts`（总入口与 HTML/默认设计体系管理）、`blocks.ts`（块与建议持久化）、`entries.ts`（Store 条目批处理、乐观锁与 `GET /view` 拼装）、`types.ts` 与 `types/<type>/`（中英双语 `SKILL.md` 与 `references/*.md` 渐进披露指南） |
| `packages/protocol/src/artifact/`、`rules/order.ts`、`rules/display.ts` | 跨端形状、Zod Schema、接口定义、分数顺序键 `keyBetween` 与沙箱常量 `htmlSandbox` |
| 表 `artifact`、`artifact_version`、`artifact_block`、`artifact_block_revision`、`artifact_change`、`artifact_suggestion`、`artifact_entry`、`artifact_entry_change` | Artifact 主表、HTML 版本表、块与建议表、结构化条目表及增量变更日志表 |
| `apps/web/src/features/artifact/` | `ArtifactsPage.tsx`、`ArtifactCanvas.tsx`、`BlocksView.tsx`、`StoreArtifactView.tsx` 及各类型专用工作台视图（`SlidesStoreView`、`DashboardView`、`MotionStoreView`、`MotionControls`、`WhiteboardView`、`DesignCanvasView`、`DesignSystemView`）与 `<artifact-view-context>` 上报（`store.ts`） |

接口见 [capabilities.md](docs/reference/capabilities.md)（`artifact.*`、`GET /api/v1/artifact/<id>/<version>` 与 `GET /api/v1/artifact/<id>/view`）。

## 模型和不变量

### 结构化多条目作品（`store`）与七种 `ArtifactType`

- **扁平条目树 + 逐条目乐观并发（`ifRev`）**：每个 `body = "store"` 的 Artifact 由规范化相对路径（禁绝对路径、`..` 与控制字符，单条目上限 1MB、总数上限 500）索引的 `artifact_entry` 组成。`artifact.entry.batch` 在单写锁单事务内原子执行 `set`、`patch`（RFC 7396 JSON Merge Patch）、`delete`、`copy`：任一写操作带 `ifRev`（`0` 要求不存在，`>0` 要求匹配当前 `rev`）且不满足时，整批不落库并返回 `{ applied: false, conflicts }` 供调用方对账重试；成功时递增 `artifact.seq`、写入 `artifact_entry_change`，并经 `artifact.entry.follow` SSE 流推送。
- **渐进披露类型指南（`artifact.type.list`、`artifact.type.read`）**：每种 `ArtifactType` 在服务端内置中英双语 `SKILL.md` / `SKILL.en.md` 与按职责拆分的 `references/*.md`（布局、交互契约、视觉工艺等）。助手与帮工常驻提示只带简短类型目录，动工前按语言读取对应类型的 `SKILL` 与所需分册，不把全部规范塞进常驻上下文。
- **全农场的默认设计体系（`isDefault`）**：`artifact` 表以部分唯一索引保证同一时刻至多一个 `artifact_type = 'design-system'` 标为 `isDefault = true`。`GET /api/v1/artifact/<id>/view` 在渲染 `slides`、`dashboard`、`design` 时自动把默认设计体系 `"project/tokens.json"` 编译出的 `:root` 与 `[data-theme="light"|"dark"]` CSS 变量注入在作品样式之前，作品自身样式始终可覆盖。
- **各类型的专用运行时与人机双向编辑**：
  - **`slides`**：`"project/deck.json"` + `"project/deck.css"` + `project/slides/<id>.html`；支持 `16:9`（1920×1080）与 `4:3`（1440×1080）画幅、`.fragment` 分步揭示、备注、演讲者视图 `BroadcastChannel` 同步、`?print=1` 逐页打印，以及工作台划词改字、单页 HTML 编辑和增页。
  - **`dashboard`**：`datasets/<id>` + `dash/params` + `files/index.html`；沙箱注入 `window.dash`（`data`、`calc`、`params`、`onData`、`colors`），自动扫描页面内 `[data-source][data-field][data-agg]` 数字与源表核对，向宿主汇报核验徽章、点击数字联动打开右侧数据源抽屉、支持编辑 JSON 与导出 CSV。
  - **`motion`**：支持 `film/meta` + `"modules/scenes.json"` + `film/script` 纯时间函数 `window.CUT.render(t)`（带 `window.kit` 缓动、弹簧与字幕排布帮手），与单页 `display: "motion"` 共用工作台 `MotionControls`（播放/暂停、逐帧 `-1f`/`+1f`、章节跳转、循环，以及沙箱内按帧步进 `captureStream(0)` + `MediaRecorder` 导出确定性 WebM 视频存入素材库）。
  - **`whiteboard`**：工作台用原生 Solid 画布直接渲染 `board/meta` 与 `elements/<id>`（平移缩放、网格吸附、正交折线箭头 `bends`、容器、表格、经净化的内联 SVG、独立沙箱 `html` 小部件，以及帮工画图占位的 `claim` 虚线框），人类拖拽、连线、双击改字与帮工写 `elements/<id>` 实时互相同步。
  - **`design`**：`"project/canvas.json"` + `.dc.html` 多画板探索；沙箱解析 `<x-dc data-props>`、`<helmet>` 与 `DCLogic`，右侧属性面板生成滑块、下拉、开关与输入框实时预览，点保存写回 `.dc.html` 默认值。
  - **`design-system`**：`"project/design-system.json"` + `"project/tokens.json"` + `project/README.md` + `project/components/<Name>/preview.html`；分栏查看文档、双主题色板与自动 WCAG 对比度徽章、字体字阶样张、组件沙箱预览与令牌源码，并可一键设为默认设计体系。

### 当前视图上下文（`<artifact-view-context>`）

- 工作台任意打开的 Artifact 视图将当前位置（如 `slideIndex`/`slideId`、`activeDataset`、`selectedIds`、`activeArtboard`、`activeTab`、`selectedBlockIds` 或播放秒数 `time`）写入 `activeArtifactViewContext`。
- 用户在聊天框或 Artifact 旁栏发消息时，协议附带可选 `ArtifactViewContext`；频道将其存进消息元数据，并在投递给助手和帮工时拼成带不可信围栏的 `<artifact-view-context>` 块，使「把这一页标题改短」「放慢这里的转场」无需手动指明页码或秒数。

### 单页网页（`html`）

- **每一稿是一个附件，版本不可变**：单版上限 5MB，字节经 `Attachment.keep` 存一次，`artifact_version.attachment_id` 指向它；提交新版追加 `artifact_version` 记录，不覆盖旧版；删掉 Artifact 不删附件。
- **双层沙箱隔离**：`GET /api/v1/artifact/<id>/<version>` 与 `GET /api/v1/artifact/<id>/view` 响应头均携带严格 CSP（`sandbox` 不含 `allow-same-origin`，`connect-src 'none'`），前端 `iframe` 同步设 `sandbox={htmlSandbox}`。
- **提交前静态白名单检查（`@vibevalley/artifact/html`、`viewers`）**：仅放行 `cdn.jsdelivr.net`、`cdnjs.cloudflare.com`、`fonts.googleapis.com`、`fonts.gstatic.com`，媒体须为同源附件路径、`data:` 或 `blob:`；含表外外链、表单提交或嵌套页面的直接拒绝。
- **怎么看（`display`）与外壳约定（`@vibevalley/artifact/shell`）**：单页 HTML 带 `display`（`page`、`slides`、`motion`）；请求 `?shell=1&display=…&theme=…` 时服务端接上主题变量、划词脚本与 `vv` 运行时（含 `vv.timeline(duration, renderAt, { fps, chapters })` 确定性时间轴），两头只按 `HtmlShellMessage`、`HtmlShellCommand` 的 Schema 通信。
- **划词源码替换（`artifact.html.edit`）**：划词生成选中文本及前后各 32 字的 `HtmlAnchor`；服务端在最新版源码中唯一匹配并替换该处转义字节存为新版，跨标签或有歧义则拒绝。

### 协作块文档（`blocks`）

- **扁平块表 + 分数索引排序**：每块含客户端生成的 UUID `id`、`parentId` 和不以 `0` 结尾的 base62 顺序键 `orderKey`，同级按 `(orderKey, id)` 排序；`split_block.offset` 按 Unicode 码点计算。
- **单写锁批处理与幂等 `batchId`**：`artifact.submit` 在单锁单事务内按序施加 `BlockOp[]`、递增文档 `seq` 与块 `rev` 并返回 `BlockAck`；相同 `batchId` 重发直接返回首次结果。
- **按 `baseRev` 与文本比对判冲突**：`update_text` 与 `split_block` 携带 `baseRev`；若 `baseRev` 落后但该块文本未变仍正常施加，文本已变则返回 `conflict` 并将提交文本存为 `conflict` 修订。
- **用户写过的块受保护（`Suggestion`）**：agent 对 `updatedBy = "user"` 的块调修改或删除时，服务端不改原块，而是记一条带 `baseRev` 的 `Suggestion`；用户接受时若块当前 `rev` 仍等于 `baseRev` 才应用，否则作废。
- **实时推送与拼字保护**：块与建议经 `artifact.follow`、`artifact.suggestion.follow` 实时推送；前端 `BlockEditor` 对正聚焦、正处于输入法拼字或有待发改动的块保留本地文本，失焦且在途批次落定后再应用远端更新。

## 怎么走

**创建与共创结构化 Artifact**

1. 助手或帮工调 `artifact_type_read` 读取目标类型的技能指南，再调 `artifact_create`（`kind: "store"`、`artifactType` 与初始 `entries`，或 `kind: "markdown"` / `"html"`）；用户在 `/artifacts` 点类型菜单选择一种类型时由 `starterEntriesForType` 生成可立即预览的初始条目。
2. 服务端校验条目或 HTML/Markdown，在对应工单串或频道发出带 `ArtifactCard`（含类型徽章与图标）的消息并落库。
3. 后续人类在专用视图中操作控件（改页、改数据集、拖白板节点、调 `data-props`、改设计令牌）与帮工调 `artifact_entry_batch` 走同一套乐观并发 Store 管线，经 `artifact.entry.follow` 双向实时同步。

## 和谁打交道

- **频道（`channel`）**：调用 `channel.post({ _tag: "Announce" })` 发 Artifact 卡片；在消息中记录被引用的块快照与当前打开的 `ArtifactViewContext`。
- **附件与素材库（`attachment`、`media`）**：HTML 版本与 Store 的 `asset` 条目引用 `attachment`；`motion` 导出的 WebM 视频上传为附件并加入素材库。
- **工具（`tool`、`mcp`）**：向助手和帮工暴露 `artifact_*`（含 `artifact_type_*` 与 `artifact_entry_*`）工具，自动绑定会话工单与档案身份。
- **「连接到本机」（`lan`）**：放行配对设备访问 `GET /api/v1/artifact/<id>/<version>` 与 `GET /api/v1/artifact/<id>/view`。

## 为什么这样

- **共享多条目 Store 底座，而不是每加一种类型建一套新表和新工具**：幻灯片、看板、短片、白板、界面画板和设计体系都需要局部增删改、按修订号防覆盖与增量流式同步；抽成统一的 `artifact_entry` + `artifact.entry.batch` 后，6 种结构化类型共用同一套持久化、SSE 与 MCP 工具面，同时保留 `blocks` 的逐段建议保护与 `html` 的零门槛单文件交付。
- **技能指南按需读取，不塞进常驻系统提示**：每种创作类型的版式、配色、时间轴和防踩坑规范很长；放进 `artifact.type.read` 按语言与分册渐进披露，既让模型在动工时拿到完整工艺标准，又不挤占日常对话上下文。
- **不可信代码一律关在无同源权限的独立视图路由里，连录屏也在沙箱内完成**：Store 中的 `.html`、`.dc.html`、看板脚本与短片脚本均经 `GET /api/v1/artifact/<id>/view` 配合 `sandbox allow-scripts`（无 `allow-same-origin`、`connect-src 'none'`）加载；`whiteboard` 宿主页面直接画结构化节点、SVG 经白名单剥离脚本并走 `data:image/svg+xml` 渲染，`motion` 视频导出在沙箱帧内完成合成后再经 `postMessage` 交宿主落盘，彻底阻断脚本触碰主站凭证或接口。

## 还没做的

- 网页 Artifact 元素锚点、锚点评论标记与自适应高度回报：[网页 Artifact 的元素锚点、锚点评论与高度回报](.agents/notes/proposed/feature/2026-11-04-html-artifact-display.md)。
- 父子工单分节绑定与按节确认定稿：[几个帮工同时写一篇文章](.agents/notes/proposed/feature/2026-10-20-block-editor-ux.md)。
- 块编辑器在线光标、块内三方合并（`merged`）与修订历史找回。

## 怎么验证

- `packages/artifact/src/artifact.test.ts`、`store.test.ts`：外壳消息与 `vv.timeline` 注入、JSON Merge Patch、设计令牌编译与对比度、白板 SVG 净化、`.dc.html` `data-props` 回写与 Store CSP 头测试。
- `apps/server/src/modules/artifact/policy.test.ts`、`check.test.ts`、`edit.test.ts`、`blocks.rules.test.ts`、`blocks.test.ts`、`artifact.test.ts`、`store.test.ts`、`http/artifact.test.ts`：CSP 响应头、白名单拦截、块协同与 `Suggestion`、七种类型指南中英双语读取、`ifRev` 乐观并发冲突、默认设计体系令牌自动注入与 `<artifact-view-context>` 投递测试。
- `apps/web/test/artifact.spec.ts`、`artifact-blocks.spec.ts`、`slides.spec.ts`、`artifact-types.spec.ts`：沙箱隔离、划词改字、块协同、幻灯片放映打印，以及看板溯源核验、白板画布交互、设计体系默认切换、画板属性调节、短片时间轴与聊天视图上下文端到端测试。
