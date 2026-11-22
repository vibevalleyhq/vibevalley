# Artifact

Artifact（`Artifact`）是用户、助手和帮工共创或交付的文档、大纲笔记与交互作品，统一归入 `/library` 交付物视图，在 `/artifacts` 详情页与聊天旁栏 `ArtifactCanvas` 中查看与双向编辑。底层按存储形态（`body`）分三种，并在此之上提供八种结构化创作类型（`ArtifactType`），由内容平面专属的 Loro 1.18.0 协同引擎（`crates/core/src/collab/`）承载实时感知、字符/属性/树层级并发合并、持久化游标建议与时间旅行回放：

- **协作块文档与大纲笔记（`blocks`，对应 `artifactType = "docs"` 与 `"outline"`）**：由段落、标题、列表、待办、代码等块组成，底层通过 `LoroTree`（层级与排序）+ `LoroText`（正文）协同合并并投影至 `artifact_block`，支持导出 Markdown。`docs` 面向章节式长文交付；`outline`（复合后缀 `.outline.md`）面向轻量单栏树状大纲、会议纪要与日常工作记录，与其余作品共享模板库、频道卡片、工单关联、右侧协作抽屉与时间旅行。
- **结构化多条目作品（`store`）**：由带路径与修订号 `rev` 的命名条目（`artifact_entry`：`text`、`json`、`asset`）组成，协同状态由 `LoroMap`/`LoroList`/`LoroTree` 驱动属性级合并，承载六种专用创作运行时——**幻灯片（`slides`）**、**数据看板（`dashboard`）**、**动态短片（`motion`）**、**无限白板（`whiteboard`）**、**界面画板（`design`）** 与 **设计体系（`design-system`）**。
- **单页网页（`html`）**：完整单页 HTML，按版本不可变存储（协同源码同步由 `LoroText` 承载），支持 `display`（`page`、`slides`、`motion`），在严格沙箱中隔离展示并支持划词改字、沙箱实时高亮与时间轴录屏导出。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| Artifact 元数据、工单外键关联（`artifact.issue`）、默认设计体系标记（`isDefault`）、频道卡片投递、块序列、Store 条目、HTML 版本与 Loro 协同快照（`artifact_collab`） | 对话中的卡片回复与唤醒（[频道](docs/subsystems/channel.md)） |
| 八种 `ArtifactType`（含 `outline`）的渐进披露双语指南（`artifact.type.list`、`artifact.type.read`）与默认令牌注入 | 消息普通文件附件与素材库底层管理（[频道](docs/subsystems/channel.md)、[媒体和素材库](docs/subsystems/media.md)） |
| 内容平面协同内核：`PresenceHub` 纯内存实时在场（`artifact.presence.{update,follow}`）、`CollabDoc` 字符/属性/树层级合并、`CommitMeta`、持久化 `Cursor` 建议（`Suggestion`）、时间旅行/浅快照/按 `origin` 选择性撤销（`artifact.history.*`）与 Store 增量同步（`artifact.entry.follow`） | 控制平面核心状态（[核心状态](docs/subsystems/core.md)）、事件流平面（[帮工](docs/subsystems/session.md)）与代码平面（[仓库](docs/subsystems/repo.md)） |
| Markdown 与块互转、HTML/SVG 白名单净化、复合后缀推断（含 `.outline.md`）、划词替换（`artifact.html.edit`）与严格 CSP 沙箱视图拼装（`artifact.view` / `GET /api/v1/artifact/<id>/view`） | 助手与帮工提示拼装本身（[帮工](docs/subsystems/session.md)、[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/core/src/artifact/`、`crates/core/src/collab/` | 服务端跑的 Rust 引擎与单一真相源：`artifact/` 含 `ops.rs`、`markdown.rs`、`html.rs`、`shell.rs`（含严格 CSP 沙箱 `presence_highlight_script`）、`store.rs`、`tokens.rs`、`viewers.rs`、`starters.rs`；`collab/` 含 Loro 1.18.0 内容平面内核 `presence.rs`（纯内存 `PresenceHub`）与 `doc.rs`（`CollabDoc`、`CommitMeta`、`TextRangeAnchor`、`coalesce_suggestions`、时间旅行、浅快照压缩与按 `origin` 选择性撤销）；维护 `artifact_golden.rs` 与 `collab_loro.rs` 测试 |
| `crates/server/src/modules/content/artifact/` | `Artifacts`：`mod.rs`（总入口、HTML、默认设计体系与接口安装）、`collab.rs`（Loro 1.18.0 Phase A/B/C 接入：每作品 `PresenceHub`、`CollabDoc` CRDT Proxy、持久 `Cursor` 建议与 `artifact.history.*`）、`blocks.rs`（块与建议持久化）、`entries.rs`（Store 条目批处理、乐观锁、历史 `presence/*` 零落库拦截、`artifact.entry.follow` 与 `artifact.view` 拼装）、`types.rs`（嵌入 `crates/server/assets/artifact/types/` 八种类型的中英双语 `SKILL.md` / `SKILL.en.md` 与 `references/*.md`）、`db.rs` |
| `apps/mac/ui/features/artifact/`、`apps/mac/ui/features/content/` 与 `apps/mac/ui/features/media/` | 原生应用 nsh TSX 页面与客户端辅助：块编辑器与单栏大纲模型（`blocks.ts`、`editor.ts`）、实时在场与网关订阅（`gateway.ts`、`store.ts` 的 `followArtifactPresence` / `useArtifactPresence`）、HTML 后缀推断与沙箱高亮桥（`html.ts`、`shell.ts`、`frame.ts`、`HtmlFrame.tsx`）、Store 消息守卫（`viewers.ts`），以及 `ArtifactsPage`（36px 单行页头、全出血画布、默认收起的可按需展开实时 `ChannelSidePane` 协作抽屉与 `TimelineBar.tsx` 时间旅行滑块）、`ArtifactCanvas`、`BlocksView`（行内协作者光标与持久游标 `Tab`/`Esc` 建议）、`StoreArtifactView`、各类型专用视图（`SlidesStoreView`、`DashboardView`、`MotionStoreView`、`MotionControls`、纯壳层 `WhiteboardView`（挂载 `crates/rich/` 原生 `VvWhiteboard`）与 `DesignCanvasView`、`DesignSystemView`）、`<artifact-view-context>` 上报，以及 `ContentShell` 下的二元内容中心与 19 套双语模板库 |
| `crates/protocol/src/contract/artifact.rs`、`packages/protocol/src/artifact/` | 跨端契约（Rust 为源、生成 TS 形状与端点，含 `ArtifactType::Outline`、`ArtifactPresence*`、`ArtifactHistory*` 与 `Suggestion` 游标字段）、Zod Schema，以及 `packages/protocol/src/rules/order.ts`（`keyBetween`）与 `display.ts`（`htmlSandbox`） |
| 表 `artifact`、`artifact_collab`、`artifact_version`、`artifact_block`、`artifact_block_revision`、`artifact_change`、`artifact_suggestion`、`artifact_entry`、`artifact_entry_change` | Artifact 主表（`artifact_type` 允许 `'outline'`，`issue` 外键 `on delete set null`）、Loro 二进制协同快照表 `artifact_collab`、HTML 版本表、块与带持久化游标列的建议表、结构化条目表及增量变更日志表（均在 `server.db`） |

接口见 [capabilities.md](docs/reference/capabilities.md)（`artifact.*`、`GET /api/v1/artifact/<id>/<version>` 与 `GET /api/v1/artifact/<id>/view`）。

Artifact 使用 SQLx 访问 SQLite。sqlc 从 Artifact 与频道的正式表结构生成命名查询。频道消息不存在时，左连接返回空引用；工单删除时 `artifact.issue` 由外键自动置空（`on delete set null`）。版本与 `asset` 条目的文件内容由附件库保管（[查询](crates/server/src/db/queries/content_artifact.sql)）。

频道中的 Artifact 卡片、版本号和消息引用由 `Chat::post_with` 在同一连接上提交。版本写入失败时，频道回滚消息和事件，恢复内存镜像。订阅者只收到已提交的卡片。

## 模型和不变量

### 结构化多条目作品（`store`）与八种 `ArtifactType`

- **扁平条目树 + 逐条目乐观并发（`ifRev`）与 Loro 属性级合并**：每个 `body = "store"` 的 Artifact 由规范化相对路径（禁绝对路径、`..` 与控制字符，单条目上限 2MB、总数上限 500）索引的 `artifact_entry` 组成。`artifact.entry.batch` 在单写锁单事务内原子执行 `set`、`patch`（RFC 7396 JSON Merge Patch）、`delete`、`copy` 并同步提交到 `CollabDoc`（`LoroMap` / `LoroText`）：任一写操作带 `ifRev`（`0` 要求不存在，`>0` 要求匹配当前 `rev`）且不满足时，整批不落库并返回 `{ applied: false, conflicts }` 供调用方对账重试；成功时递增 `artifact.seq`、写入 `artifact_entry_change`（变更日志保留 30 天）与 `artifact_collab`，并经 `artifact.entry.follow` SSE 流推送（超过 256KB 的正文不内联，由客户端按需拉取）。历史风格的 `presence/*` 条目写入在 `entries.rs` 被直接拦截转入纯内存 `PresenceHub`，不再写库或递增 `seq`。
- **渐进披露双语指南（`artifact.type.list`、`artifact.type.read`）**：全部八种 `ArtifactType`（`outline`、`docs`、`slides`、`dashboard`、`motion`、`whiteboard`、`design`、`design-system`）在服务端内置中英双语 `SKILL.md` / `SKILL.en.md` 与按职责拆分的 `references/*.md`（布局、交互契约、视觉工艺等）。助手与帮工常驻提示只带简短类型目录，动工前按当前语言读取对应类型的 `SKILL` 与所需分册，不把全部规范塞进常驻上下文。
- **全空间的默认设计体系（`isDefault`）**：`artifact` 表以部分唯一索引 `artifact_default_design_system` 保证同一时刻至多一个 `artifact_type = 'design-system'` 标为 `isDefault = true`。`artifact.view`（及 `GET /api/v1/artifact/<id>/view`）在渲染 `slides`、`dashboard`、`design` 时自动把默认设计体系 `"project/tokens.json"` 编译出的 `:root` 与 `[data-theme="light"|"dark"]` CSS 变量注入在作品样式之前，作品自身样式始终可覆盖。
- **各类型的专用运行时与人机双向编辑**：
  - **`outline`**：轻量单栏树状大纲（`body = "blocks"`，复合后缀 `.outline.md`）；与 `docs` 共享 `LoroTree` + `LoroText` 底座，在工作台呈现简洁单栏大纲视觉节奏、默认圆点列表与 `Tab`/`Shift+Tab` 缩进/反缩进，无重型属性表噪音；统一接入模板库（空白大纲、技术方案大纲、会议纪要、每日工作记录）、频道分享、关联工单、右侧协作抽屉与时间旅行。
  - **`slides`**：`"project/deck.json"` + `"project/deck.css"` + `project/slides/<id>.html`；支持 `16:9`（1920×1080）与 `4:3`（1440×1080）画幅、`.fragment` 分步揭示、备注、演讲者视图同步、`?print=1` 逐页打印，以及工作台划词改字、单页 HTML 编辑和增页。
  - **`dashboard`**：`datasets/<id>` + `dash/params` + `files/index.html`；沙箱注入 `window.dash`（`data`、`calc`、`params`、`onData`、`colors`），自动扫描页面内 `[data-source][data-field][data-agg]` 数字与源表核对，向宿主汇报核验徽章、点击数字联动打开右侧数据源抽屉、支持编辑 JSON 与导出 CSV。
  - **`motion`**：支持 `film/meta` + `"modules/scenes.json"` + `film/script` 纯时间函数 `window.CUT.render(t)`（带 `window.kit` 缓动、弹簧与字幕排布帮手），与单页 `display: "motion"` 共用工作台 `MotionControls`（播放/暂停、逐帧 `-1f`/`+1f`、章节跳转、循环，以及沙箱内按帧步进 `captureStream(0)` + `MediaRecorder` 导出确定性 WebM 视频存入素材库）。
  - **`whiteboard`**：由 `crates/rich/` 的纯 Rust 原生组件 `VvWhiteboard`（`crates/rich/src/whiteboard.rs` 与 `engine/whiteboard/*`）直接在 GPUI 双层 `canvas` 上绘制与交互，`WhiteboardView` 负责同步 `artifact_entry`、订阅 `artifact.presence.follow` 并将 `onCursorMove` / `onViewportChange` 节流回传 `artifact.presence.update`（彻底移除 `presence/*` 数据库条目写入）：支持无限平移缩放、方格/点阵网格、网格与间距吸附、对齐/分布/整理、25 款手绘贴纸、工作坊便签/胶囊计划流、容器顶部外浮标题、平滑插值协作光标与状态气泡（遵守 `reduce_motion` / `VIBEVALLEY_NO_ANIMATION`）、`highlight`/`claim` 虚线区域占位框、远端视口边框淡显、右上角在线协作者胶囊一键 **Follow 视口**（任何手动拖拽/滚轮/缩放/Reset/`Esc` 立即退出跟随）、工作坊计时器、压力感应 `pen`/`highlighter`、橡皮擦、正交折线箭头 `bends`、容器子级编组、表格、6 套双语模板（含启动工作坊 `Workshop`）、小地图、JSON Canvas `.canvas` 互通与 SVG / 2x PNG / JSON 导出；人类操作与帮工写 `elements/<id>` 走同一 `artifact.entry.batch` 管线实时同步。
  - **`design`**：`"project/canvas.json"` + `.dc.html` 多画板探索；沙箱解析 `<x-dc data-props>`、`<helmet>` 与 `DCLogic`，右侧属性面板生成滑块、下拉、开关与输入框实时预览，点保存写回 `.dc.html` 默认值。
  - **`design-system`**：`"project/design-system.json"` + `"project/tokens.json"` + `project/README.md` + `project/components/<Name>/preview.html`；分栏查看文档、双主题色板与自动 WCAG 对比度徽章、字体字阶样张、组件沙箱预览与令牌源码，并可一键设为默认设计体系。

### Loro 1.18.0 内容平面协同引擎（Phase A / B / C）

- **单平面严格边界**：Loro CRDT 仅服务于内容平面（Artifact），严禁侵入控制平面（`Core::reduce` + SQLite 强事务）、事件流平面（只追加 `SessionEvent` / `seq`）与代码平面（Git worktree）。
- **Phase A — 纯内存实时感知（`PresenceHub`）**：服务端按 `artifact_id` 维护驻留内存的 `PresenceHub`（封装 `loro::awareness::EphemeralStore`，默认 30 秒 TTL），通过 `artifact.presence.update` 与订阅流 `artifact.presence.follow`（先推全量 `Snapshot`，后续增量推 `Upsert`/`Remove` 并定期淘汰过期条目）同步光标、块光标、选区、区域高亮与视口，**零 SQLite 写入且绝不递增 `artifact.seq`**。原生 `VvWhiteboard` 渲染平滑插值光标/占位框并支持一键 Follow 视口；`BlocksView` 展示块级在线协作者胶囊并上报本地 `block_cursor`/`selection`；`HtmlFrame`（`html`/`slides`/`dashboard`/`design`）在不放宽 CSP 的前提下通过 `presence_highlight_script()` 与 `postMessage({ vibevalley: "presence-highlight", items })` 绘制沙箱区域呼吸高亮。
- **Phase B — `CollabDoc` CRDT Proxy 与持久化 `Cursor` 建议**：服务端惰性从 `artifact_collab` 加载 `CollabDoc`（首次从现有 SQLite 状态确定性引导），在同一写事务中将 `LoroText` / `LoroTree`（启用 `enable_fractional_index(0)`）/ `LoroMap` / `LoroList` 快照写回 `artifact_collab` 并同步投影 `artifact_block` / `artifact_entry` / `artifact_version`（保持 CLI 与 SQL 查询可读）。每次提交通过 Loro `commit_msg` 持久化 `CommitMeta`（`CommitMeta::user`、`CommitMeta::session`、`CommitMeta::undo`）。执行会话修改用户写过的块时，服务端经 `CollabDoc::anchor_text_range` 生成持久化 Loro `Cursor`（`cursorStart` / `cursorEnd`），同 `origin` 相邻或重叠修改经 `coalesce_suggestions` 折叠为单条建议；即使用户在上下游增删字符导致块 `rev` 推进，建议仍按实时漂移区间精确呈现并在 `Tab` 接受时无损合并（仅当被锚定的原文片段自身被覆盖时拒绝）。
- **Phase C — 时间旅行、浅快照压缩与按 `origin` 选择性撤销**：服务端接入 `artifact.history.{list,preview,restore,fork,undoOrigin,compact}`；工作台详情页通过 `artifact-timeline-toggle` 展开 [TimelineBar.tsx](apps/mac/ui/features/artifact/TimelineBar.tsx)，按作者与执行会话着色的提交轨迹支持只读历史预览（`checkout_snapshot`）、一键恢复（`restore_to`）、从历史点分叉为新作品（`fork_at`，重映射块 ID）、基于 `ExportMode::shallow_snapshot` 的浅快照压缩，以及按 `origin` 计算精确逆向补丁（`doc.diff(&after, &before)`）的**选择性撤销**（仅撤指定执行会话轮次，完整保留人类与其他并发会话编辑）。

### 统一内容中心、全出血画布与当前视图上下文（`<artifact-view-context>`）

- **统一二元内容中心与全出血详情页（`/library`、`/artifacts/:id`）**：内容中心收敛为「**作品（含 `outline` 大纲笔记共 8 种类型）+ 素材**」二元结构，共用 `ContentShell` 下的可折叠 `ContentSidebar`（全屏演示 `contentPresenting` 时自动收起），支持拖拽带复合后缀的文件建 Artifact 或经 `+ 新建` 19 套双语模板库直接起步。在 `/library` 单击作品卡直达 `/artifacts/:id`（无 `:id` 时自动打开最近作品）；详情页采用 `36px`（`h-9`）单行页头（侧栏收起时显示 `artifact-back-library` 返回按钮，原地改名、类型/版本/作者与关联任务徽章、时间旅行 `artifact-timeline-toggle`、置顶、发到频道、按形态导出 Markdown / HTML / Store JSON、协作抽屉开关、转为任务与删除），`store` 与 `html` 类宽画布作品全出血铺满容器，`blocks` 文档与 `outline` 大纲保持居中阅读栏；右侧实时 `ChannelSidePane` 协作抽屉对画布类作品默认收起以保留最大视野，点击协作按钮或白板「问助手」即刻展开。
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
- **用户写过的块受保护（持久 `Cursor` 建议 `Suggestion`）**：agent 对 `updatedBy = "user"` 的块调修改或删除时，服务端不直接覆盖原块，而是用 Loro 持久化 `Cursor`（`cursorStart`/`cursorEnd`）锚定建议片段并折叠同 `origin` 重叠修改；即使人类在上下游继续改字令块 `rev` 递增，建议仍按实时漂移位置支持 `Tab` 接受或 `Esc` 拒绝（仅当锚定原文自身被改写时拒绝）；无游标旧建议按 `baseRev` 校验。
- **实时推送与拼字保护**：块、建议与实时在场分别经订阅流 `artifact.follow`、`artifact.suggestion.follow`、`artifact.presence.follow`（[SSE 流](docs/subsystems/core.md#sse-流和其余路由)）实时推送；前端 `BlockEditor` 对正聚焦、正处于输入法拼字或有待发改动的块保留本地文本，失焦且在途批次落定后再应用远端更新。

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
- Loro 远端浏览器 WASM/JS 双向同步、流式 token 微批事务合并与 `VvWhiteboard` 本地直写副本等后续演进（Phase A/B/C 核心端到端能力已在 Wave 2 落地）：[Loro 协作内容引擎：四平面边界、实时感知、块内共编与时间旅行](.agents/notes/proposed/architecture/2026-11-22-loro-collaborative-content-engine.md)。

## 怎么验证

- `crates/core/tests/collab_loro.rs`：Loro 1.18.0 内容平面单测与并发收敛属性测试（Ephemeral TTL、3 端 6 排列并发修改文本/属性/树层级、持久 `Cursor` 上游漂移、时间旅行 `checkout`/分叉、浅快照压缩、按 `origin` 选择性撤销）。
- `crates/core/tests/artifact_golden.rs`：Rust 引擎的块操作、Markdown 往返、HTML 检查、划词改字、Store 补丁、设计令牌、初始模板与视图拼装回归 golden（`vp run protocol:check` / `vp run goldens` 校验）。
- `crates/rich/tests/*`：原生 `VvWhiteboard` 实时在场解码、平滑插值、一键 Follow 视口与手动退出、`onCursorMove` / `onViewportChange` 回调与组件声明校验。
- `crates/server/tests/artifact.rs`：HTML 与 Markdown 交稿、八种类型（含 `outline`）双语指南读取、Store 批处理与 `ifRev` 冲突、白板 SVG 净化、`artifact.view` 与默认设计体系令牌注入、`artifact.entry.follow`、纯内存 `artifact.presence.{update,follow}` 与历史 `presence/*` 零落库、持久 `Cursor` 建议跨上游编辑合并与折叠、`artifact.history.*` 时间旅行/压缩/按 `origin` 选择性撤销，以及 `artifact.issue` `ON DELETE SET NULL` 外键测试。
- `apps/mac/ui/features/artifact/artifact.test.ts`、`apps/mac/ui/app/interactions.test.tsx`、`apps/mac/ui/app/scenarios.test.tsx`：客户端编辑 span 快捷键、UTF-16 offset、iframe 外壳/Store 消息守卫、复合后缀推断（含 `.outline.md`）、`TimelineBar`、全出血白板协作抽屉、二元内容中心上下文记忆与多密度场景页面测试（`nsh/test`）。

演讲者视图在 HTML 发回页数后显示页码、下一页与备注。尚未收到回执时，页面显示「等待演示页就绪」。载入错误显示具体原因（[原生页面验收](.agents/skills/vv-acceptance/references/app.md#演示页的就绪回执)）。
