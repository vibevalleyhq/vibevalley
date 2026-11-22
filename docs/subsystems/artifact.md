# Artifact

Artifact（`Artifact`）是用户、助手和帮工共创或交付的文档与交互作品，统一归入 `/library` 交付物视图，在 `/artifacts` 详情页与聊天旁栏 `ArtifactCanvas` 中查看与双向编辑。底层按存储形态（`body`）分三种，并在此之上提供七种结构化创作类型（`ArtifactType`）：

- **协作块文档（`blocks`，对应 `artifactType = "docs"`）**：由段落、标题、列表、待办、代码等块组成，按 `BlockOp` 协同修改，服务端为唯一权威，支持导出 Markdown。
- **结构化多条目作品（`store`）**：由带路径与修订号 `rev` 的命名条目（`artifact_entry`：`text`、`json`、`asset`）组成，承载六种专用创作运行时——**幻灯片（`slides`）**、**数据看板（`dashboard`）**、**动态短片（`motion`）**、**无限白板（`whiteboard`）**、**界面画板（`design`）** 与 **设计体系（`design-system`）**。
- **单页网页（`html`）**：完整单页 HTML，按版本不可变存储，支持 `display`（`page`、`slides`、`motion`），在严格沙箱中隔离展示并支持划词改字与时间轴录屏导出。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| Artifact 元数据、工单外键关联（`artifact.issue`）、默认设计体系标记（`isDefault`）、频道卡片投递、块序列、Store 条目与 HTML 版本存储 | 对话中的卡片回复与唤醒（[频道](docs/subsystems/channel.md)） |
| 七种 `ArtifactType` 的渐进披露双语指南（`artifact.type.list`、`artifact.type.read`）与默认令牌注入 | 消息普通文件附件与素材库底层管理（[频道](docs/subsystems/channel.md)、[媒体和素材库](docs/subsystems/media.md)） |
| 块模型、分数顺序键（`keyBetween`）、`BlockOp` 管线、修订与建议（`Suggestion`）；Store 条目 `ifRev` 乐观并发、JSON Merge Patch 与 SSE 增量同步（`artifact.entry.follow`） | 帮工 `/mcp` 鉴权与工单生命周期（[帮工](docs/subsystems/session.md)、[工单](docs/subsystems/issue.md)） |
| Markdown 与块互转、HTML/SVG 白名单净化、复合后缀推断、划词替换（`artifact.html.edit`）与沙箱视图拼装（`artifact.view` / `GET /api/v1/artifact/<id>/view`） | 助手与帮工提示拼装本身（[帮工](docs/subsystems/session.md)、[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/core/src/artifact/` | 服务端跑的那份 Rust 引擎与单一真相源：`ops.rs`、`markdown.rs`、`html.rs`、`shell.rs`、`store.rs`、`tokens.rs`、`viewers.rs`、`starters.rs`；维护 `crates/core/tests/golden/artifact` 回归测例 |
| `crates/server/src/modules/content/artifact/` | 服务端 Artifact 读写、版本管理与 SSE 订阅 |
| `apps/mac/ui/features/artifact/`、`apps/mac/ui/features/content/` 与 `apps/mac/ui/features/media/` | 原生应用 nsh TSX 页面与客户端辅助：块编辑器模型（`blocks.ts`、`editor.ts`）、HTML 后缀推断（`html.ts`）、WebView 外壳与 `vv.timeline` 消息守卫（`shell.ts`）、Store 消息守卫（`viewers.ts`），以及 `ArtifactsPage`（单行 44px 页头、全出血画布、默认收起的可按需展开实时 `ChannelSidePane` 协作抽屉）、`ArtifactCanvas`、`BlocksView`、`StoreArtifactView`、各类型专用视图（`SlidesStoreView`、`DashboardView`、`MotionStoreView`、`MotionControls`、纯壳层 `WhiteboardView`（挂载 `crates/rich/` 的纯 Rust 原生 `VvWhiteboard`）、`DesignCanvasView`、`DesignSystemView`）、`<artifact-view-context>` 上报，以及 `ContentShell` 下的统一内容浏览与 19 套模板库 |
| `crates/server/src/modules/content/artifact/` | `Artifacts`：`mod.rs`（总入口、HTML 与默认设计体系管理）、`blocks.rs`（块与建议持久化）、`entries.rs`（Store 条目批处理、乐观锁、`artifact.entry.follow` 与 `artifact.view` 拼装）、`types.rs`（嵌入 `crates/server/assets/artifact/types/` 的中英双语 `SKILL.md` / `SKILL.en.md` 与 `references/*.md`）、`db.rs` |
| `crates/protocol/src/contract/artifact.rs`、`packages/protocol/src/artifact/` | 跨端契约（Rust 为源、生成 TS 形状与端点）、Zod Schema，以及 `packages/protocol/src/rules/order.ts`（`keyBetween`）与 `display.ts`（`htmlSandbox`） |
| 表 `artifact`、`artifact_version`、`artifact_block`、`artifact_block_revision`、`artifact_change`、`artifact_suggestion`、`artifact_entry`、`artifact_entry_change` | Artifact 主表（`issue` 列带 `references issue(id) on delete set null` 外键）、HTML 版本表、块与建议表、结构化条目表及增量变更日志表（均在 `server.db`） |

接口见 [capabilities.md](docs/reference/capabilities.md)（`artifact.*`、`GET /api/v1/artifact/<id>/<version>` 与 `GET /api/v1/artifact/<id>/view`）。

Artifact 使用 SQLx 访问 SQLite。sqlc 从 Artifact 与频道的正式表结构生成命名查询。频道消息不存在时，左连接返回空引用；工单删除时 `artifact.issue` 由外键自动置空（`on delete set null`）。版本与 `asset` 条目的文件内容由附件库保管（[查询](crates/server/src/modules/content/artifact/sql/queries.sql)）。

频道中的 Artifact 卡片、版本号和消息引用由 `Chat::post_with` 在同一连接上提交。版本写入失败时，频道回滚消息和事件，恢复内存镜像。订阅者只收到已提交的卡片。

## 模型和不变量

### 结构化多条目作品（`store`）与七种 `ArtifactType`

- **扁平条目树 + 逐条目乐观并发（`ifRev`）**：每个 `body = "store"` 的 Artifact 由规范化相对路径（禁绝对路径、`..` 与控制字符，单条目上限 2MB、总数上限 500）索引的 `artifact_entry` 组成。`artifact.entry.batch` 在单写锁单事务内原子执行 `set`、`patch`（RFC 7396 JSON Merge Patch）、`delete`、`copy`：任一写操作带 `ifRev`（`0` 要求不存在，`>0` 要求匹配当前 `rev`）且不满足时，整批不落库并返回 `{ applied: false, conflicts }` 供调用方对账重试；成功时递增 `artifact.seq`、写入 `artifact_entry_change`（变更日志保留 30 天），并经 `artifact.entry.follow` SSE 流推送（超过 256KB 的正文不内联，由客户端按需拉取）。
- **渐进披露双语指南（`artifact.type.list`、`artifact.type.read`）**：每种 `ArtifactType` 在服务端内置中英双语 `SKILL.md` / `SKILL.en.md` 与按职责拆分的 `references/*.md`（布局、交互契约、视觉工艺等）。助手与帮工常驻提示只带简短类型目录，动工前按当前语言读取对应类型的 `SKILL` 与所需分册，不把全部规范塞进常驻上下文。
- **全空间的默认设计体系（`isDefault`）**：`artifact` 表以部分唯一索引 `artifact_default_design_system` 保证同一时刻至多一个 `artifact_type = 'design-system'` 标为 `isDefault = true`。`artifact.view`（及 `GET /api/v1/artifact/<id>/view`）在渲染 `slides`、`dashboard`、`design` 时自动把默认设计体系 `"project/tokens.json"` 编译出的 `:root` 与 `[data-theme="light"|"dark"]` CSS 变量注入在作品样式之前，作品自身样式始终可覆盖。
- **各类型的专用运行时与人机双向编辑**：
  - **`slides`**：`"project/deck.json"` + `"project/deck.css"` + `project/slides/<id>.html`；支持 `16:9`（1920×1080）与 `4:3`（1440×1080）画幅、`.fragment` 分步揭示、备注、演讲者视图同步、`?print=1` 逐页打印，以及工作台划词改字、单页 HTML 编辑和增页。
  - **`dashboard`**：`datasets/<id>` + `dash/params` + `files/index.html`；沙箱注入 `window.dash`（`data`、`calc`、`params`、`onData`、`colors`），自动扫描页面内 `[data-source][data-field][data-agg]` 数字与源表核对，向宿主汇报核验徽章、点击数字联动打开右侧数据源抽屉、支持编辑 JSON 与导出 CSV。
  - **`motion`**：支持 `film/meta` + `"modules/scenes.json"` + `film/script` 纯时间函数 `window.CUT.render(t)`（带 `window.kit` 缓动、弹簧与字幕排布帮手），与单页 `display: "motion"` 共用工作台 `MotionControls`（播放/暂停、逐帧 `-1f`/`+1f`、章节跳转、循环，以及沙箱内按帧步进 `captureStream(0)` + `MediaRecorder` 导出确定性 WebM 视频存入素材库）。
  - **`whiteboard`**：由 `crates/rich/` 的纯 Rust 原生组件 `VvWhiteboard`（`crates/rich/src/whiteboard.rs` 与 `engine/whiteboard/*`）直接在 GPUI 双层 `canvas` 上绘制与交互，`WhiteboardView` 只负责同步 `artifact_entry` 与实时会话状态并响应保存/聊天事件（不再经过 `<WebView>`）：支持无限平移缩放、方格/点阵网格、网格与间距吸附、对齐/分布/整理、25 款手绘贴纸、工作坊便签/胶囊计划流、容器顶部外浮标题、协作光标气泡建议条（`presence.status`）、工作坊计时器、压力感应 `pen`/`highlighter`、橡皮擦、正交折线箭头 `bends`、容器子级编组、表格、6 套双语模板（含启动工作坊 `Workshop`）、小地图、JSON Canvas `.canvas` 互通与 SVG / 2x PNG / JSON 导出，以及帮工占位的 `claim` 虚线框；人类操作与帮工写 `elements/<id>` 走同一 `artifact.entry.batch` 管线实时同步。
  - **`design`**：`"project/canvas.json"` + `.dc.html` 多画板探索；沙箱解析 `<x-dc data-props>`、`<helmet>` 与 `DCLogic`，右侧属性面板生成滑块、下拉、开关与输入框实时预览，点保存写回 `.dc.html` 默认值。
  - **`design-system`**：`"project/design-system.json"` + `"project/tokens.json"` + `project/README.md` + `project/components/<Name>/preview.html`；分栏查看文档、双主题色板与自动 WCAG 对比度徽章、字体字阶样张、组件沙箱预览与令牌源码，并可一键设为默认设计体系。

### 统一内容中心、全出血画布与当前视图上下文（`<artifact-view-context>`）

- **统一内容中心与全出血详情页（`/library`、`/artifacts/:id`）**：Artifact 与大纲笔记、素材共用 `ContentShell` 下的可折叠 `ContentSidebar`（按 8 种精确类型筛选，全屏演示 `contentPresenting` 时自动收起侧栏），支持拖拽带复合后缀的文件建 Artifact 或经 `+ 新建` 19 套模板库直接起步。在 `/library` 单击作品卡直达 `/artifacts/:id`（无 `:id` 时自动打开最近作品）；详情页采用单行 44px 页头（返回、原地改名、类型/版本/作者与关联任务徽章、置顶、发到频道、按形态导出 Markdown / HTML / Store JSON、协作抽屉开关、转为任务与删除），`store` 与 `html` 类宽画布作品全出血铺满容器，`blocks` 文档保持居中阅读栏；右侧实时 `ChannelSidePane` 协作抽屉对画布类作品默认收起以保留最大视野，点击协作按钮或白板「问助手」即刻展开。
- **当前视图上下文（`<artifact-view-context>`）**：工作台任意打开的 Artifact 视图将当前位置（如 `slideIndex`/`slideId`、`activeDataset`、`selectedIds`、`activeArtboard`、`activeTab`、`selectedBlockIds` 或播放秒数 `time`）写入当前视图上下文。用户在聊天框或内嵌 `ChannelSidePane` 发消息时，协议附带可选 `ArtifactViewContext`；频道将其存进 `channel_message.meta` JSON，并在投递给助手和帮工时拼成带不可信围栏（转义 `</`）的 `<artifact-view-context>` 块，使「把这一页标题改短」「放慢这里的转场」无需手动指明页码或秒数。

### 单页网页（`html`）

- **每一稿是一个附件，版本不可变**：单版上限 5MB，字节经 `Attachments::keep` 存一次，`artifact_version.attachment_id` 指向它；提交新版追加 `artifact_version` 记录，不覆盖旧版；删掉 Artifact 不删附件。
- **双层沙箱隔离**：`GET /api/v1/artifact/<id>/<version>` 与 `GET /api/v1/artifact/<id>/view` 响应头均携带严格 CSP（`sandbox` 不含 `allow-same-origin`，`connect-src 'none'`），前端沙箱同步设 `sandbox={htmlSandbox}`。
- **提交前静态白名单检查（`crates/core/src/artifact/html.rs`、`viewers.rs`）**：仅放行 `cdn.jsdelivr.net`、`cdnjs.cloudflare.com`、`fonts.googleapis.com`、`fonts.gstatic.com`，媒体须为同源附件路径、`data:` 或 `blob:`；含表外外链、表单提交或嵌套页面的直接拒绝。
- **复合后缀推断与外壳约定（`html.rs`、`shell.rs`）**：单页 HTML 带 `display`（`page`、`slides`、`motion`），未显式指定时按复合后缀（`.slide.html`、`.dashboard.html`、`.motion.html`、`.whiteboard`、`.doc.md`、`.html`）与内容自动推断；请求 `?shell=1&display=…&theme=…` 时服务端接上主题变量、划词脚本与 `vv` 运行时（含 `vv.timeline(duration, renderAt, { fps, chapters })` 确定性时间轴），两头只按 `HtmlShellMessage`、`HtmlShellCommand` 的 Schema 通信。
- **划词源码替换（`artifact.html.edit`）**：划词生成选中文本及前后各 32 字的 `HtmlAnchor`；服务端在最新版源码中唯一匹配并替换该处转义字节存为新版，跨标签或有歧义则拒绝。

### 协作块文档（`blocks`）

- **扁平块表 + 分数索引排序**：每块含客户端生成的 UUID `id`、`parentId` 和不以 `0` 结尾的 base62 顺序键 `orderKey`，同级按 `(orderKey, id)` 排序；`split_block.offset` 按 Unicode 码点计算。
- **单写锁批处理与幂等 `batchId`**：`artifact.submit` 在单锁单事务内按序施加 `BlockOp[]`、递增文档 `seq` 与块 `rev` 并返回 `BlockAck`；相同 `batchId` 重发直接返回首次结果。
- **按 `baseRev` 与文本比对判冲突**：`update_text` 与 `split_block` 携带 `baseRev`；若 `baseRev` 落后但该块文本未变仍正常施加，文本已变则返回 `conflict` 并将提交文本存为 `conflict` 修订。
- **用户写过的块受保护（`Suggestion`）**：agent 对 `updatedBy = "user"` 的块调修改或删除时，服务端不改原块，而是记一条带 `baseRev` 的 `Suggestion`；用户接受时若块当前 `rev` 仍等于 `baseRev` 才应用，否则作废。
- **实时推送与拼字保护**：块与建议经订阅流 `artifact.follow`、`artifact.suggestion.follow`（[SSE 流](docs/subsystems/core.md#sse-流和其余路由)）实时推送；前端 `BlockEditor` 对正聚焦、正处于输入法拼字或有待发改动的块保留本地文本，失焦且在途批次落定后再应用远端更新。

## 怎么走

**创建与共创结构化 Artifact**

1. 助手或帮工调 `artifact_type_read` 读取目标类型的技能指南，再调 `artifact_create`（传入 `artifactType` 与初始 `entries`，或 `kind: "markdown"` / `"html"`，或工作目录内相对路径 `file`）；用户在 `/library` 或 `/artifacts` 选一种类型新建时，由 `starterEntriesForType` 生成可立即预览的初始条目。
2. 服务端校验条目或 HTML/Markdown，按需推断复合后缀与 `display`，在对应工单串或频道发出带 `ArtifactCard`（含类型徽章与图标）的消息并落库（`announce: false` 可静默创建）。
3. 后续人类在专用视图中操作控件（改页、改数据集、拖白板节点、调 `data-props`、改设计令牌）与帮工调 `artifact_entry_batch` 走同一套乐观并发 Store 管线，经 `artifact.entry.follow` 双向实时同步；用户在内嵌 `ChannelSidePane` 发话时自动携带 `<artifact-view-context>`。

## 和谁打交道

- **频道（`channel`）**：调用 `Chat::post_with` 发 Artifact 卡片；在 `channel_message.meta` 中记录被引用的块快照与当前打开的 `ArtifactViewContext`。
- **工单（`issue`）**：`artifact.issue` 以外键 `references issue(id) on delete set null` 指向工单，工单删除时自动解除关联。
- **附件与素材库（`attachment`、`library`、`media`）**：HTML 版本与 Store 的 `asset` 条目经 `Attachments` 存储与读取；`motion` 导出的 WebM 视频上传为附件并加入素材库。
- **工具与助手（`tool`、`mcp`、`orchestrator`、`watch`）**：向助手和帮工暴露 `artifact_*`（含 `artifact_type_list`、`artifact_type_read`、`artifact_entry_list`、`artifact_entry_get`、`artifact_entry_batch`）工具，自动绑定会话工单与档案身份，并将 `<artifact-view-context>` 注入助手与帮工消息行。

## 为什么这样

- **共享多条目 Store 底座，而不是每加一种类型建一套新表和新工具**：幻灯片、看板、短片、白板、界面画板和设计体系都需要局部增删改、按修订号防覆盖与增量流式同步；抽成统一的 `artifact_entry` + `artifact.entry.batch` 后，6 种结构化类型共用同一套持久化、SSE 与 MCP 工具面，同时保留 `blocks` 的逐段建议保护与 `html` 的零门槛单文件交付。
- **技能指南按需读取，不塞进常驻系统提示**：每种创作类型的版式、配色、时间轴和防踩坑规范很长；放进 `artifact.type.read` 按语言与分册渐进披露，既让模型在动工时拿到完整工艺标准，又不挤占日常对话上下文。
- **不可信代码一律关在无同源权限的独立视图路由里，连录屏也在沙箱内完成**：Store 中的 `.html`、`.dc.html`、看板脚本与短片脚本均经 `GET /api/v1/artifact/<id>/view` 配合 `sandbox allow-scripts`（无 `allow-same-origin`、`connect-src 'none'`）加载；`whiteboard` 对外部传入的 `svg` 与 `stickerSvg` 在服务端入库时经白名单剥离脚本后，全部交给纯 Rust `VvWhiteboard` 在原生画布与矢量/PNG 导出管线中渲染，`motion` 视频导出在沙箱帧内完成合成后再经 `postMessage` 交宿主落盘，彻底阻断脚本触碰宿主接口。

## 还没做的

- 网页 Artifact 元素锚点、锚点评论标记与自适应高度回报：[网页 Artifact 的元素锚点、锚点评论与高度回报](.agents/notes/proposed/feature/2026-11-04-html-artifact-display.md)。
- 父子工单分节绑定与按节确认定稿：[几个帮工同时写一篇文章](.agents/notes/proposed/feature/2026-10-20-block-editor-ux.md)。
- 块编辑器在线光标、块内并发合并、统一实时感知与时间旅行回放：[Loro 协作内容引擎：四平面边界、实时感知、块内共编与时间旅行](.agents/notes/proposed/architecture/2026-11-22-loro-collaborative-content-engine.md)。

## 怎么验证

- `apps/mac/ui/features/artifact/artifact.test.ts`：客户端编辑 span 快捷键、UTF-16 offset、iframe 外壳/Store 消息守卫与复合后缀推断（`nsh/test`）。
- `crates/core/tests/artifact_golden.rs`：Rust 引擎的块操作、Markdown 往返、HTML 检查、划词改字、Store 补丁、设计令牌、初始模板与视图拼装回归 golden（`vp run protocol:check` / `vp run goldens` 校验）。
- `crates/server/tests/artifact.rs`：HTML 与 Markdown 交稿、七种类型双语指南读取、Store 批处理与 `ifRev` 冲突、白板 SVG 净化、`artifact.view` 与默认设计体系令牌注入、`artifact.entry.follow` 回放与实时 SSE、块协同与建议，以及 `artifact.issue` `ON DELETE SET NULL` 外键测试。
- `apps/mac/ui/app/interactions.test.tsx`、`apps/mac/ui/app/scenarios.test.tsx`：全出血白板协作抽屉、统一内容上下文记忆与多密度虚拟时钟场景页面测试（`nsh/test`）。

演讲者视图在 HTML 发回页数后显示页码、下一页与备注。尚未收到回执时，页面显示「等待演示页就绪」。载入错误显示具体原因（[原生页面验收](.agents/skills/vv-acceptance/references/app.md#演示页的就绪回执)）。
