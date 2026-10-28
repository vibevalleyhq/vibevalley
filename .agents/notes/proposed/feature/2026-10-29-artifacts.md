# Agent Note: 产出（artifact）：帮工和管家做出来的一页，在 VibeValley 里看、改版、评论

Status: proposed

## Problem

帮工和管家有时要交的不是代码改动，而是一页给主人看的东西：两种设计让主人挑、一份调研报告、一张对比表、一段带图的说明。现在没有地方放：

- 工单的说明和评论只有字；文档是一块一块的字，画不了一页能看的东西。
- 田头的附件能存 HTML，但为了安全一律当下载文件给（`content-security-policy: sandbox` 加 `attachment`），点开看不了。
- 于是这类东西只能落到 VibeValley 外面（本机的文件、claude.ai 的页面），和工单、对话连不上，主人在 VibeValley 里看不到、评论不到，帮工也收不到评论。

## Proposal

一个新的概念 **产出**（artifact，界面上叫「产出」）：一页有标题、有版本的东西，由管家、帮工或主人做出来，挂在它被说出来的那个频道或工单的串里，在工作台里隔离着看。

### 是什么

- **产出**：标题、种类、在哪（频道，和可选的工单）、谁做的、当前是第几版。
- **种类**两种：`html`（一个自带样式和脚本的整页）和 `markdown`（用页面自己的 Markdown 画）。图片、PDF 照旧是附件，不另算。
- **版本**：每版的内容不再变（按 sha256 存一份），带一句「这版改了什么」。新的一版不覆盖旧的，旧版还能看。
- 一版至多 5 MB；标题 1 到 80 个字。

### 谁做、怎么做

- **帮工**（`/mcp`）：`artifact_create`、`artifact_version_create`。内容给 `content`（原文），或给 `file`：它工作目录里的一个文件，服务端去读，只认工作目录里面的路径（不跟出目录的符号链接）。默认挂在它的工单和工单的串上。
- **管家**：同样两个工具，默认挂在它正在回的频道。
- **主人**：同样的接口（命令行、页面）；页面上能删一个产出。主人在页面上写一页不在这次范围里。
- 帮工和管家还能 `artifact_list`、`artifact_get`：看一个工单或频道里有哪些、读某一版的原文，好照评论改下一版。

### 怎么出现在对话里

做出一个产出或出了新版，做的人在那个频道或串里说一句话，消息带一张**产出卡片**（标题、种类、第几版、这版改了什么）。消息的元数据里记 `artifact: { id, version }`，`ChatMessage.artifact` 带着标题和种类给页面，不另开一种事实，最近的消息本来就在帧里。

**评论**就是回复那条消息（已有的回复）：帮工在它的串里，照常被主人的话叫醒，读到回复的是哪一版。

### 在页面上怎么看

- **卡片**：工作台聊天和田头窗口的消息里；点开去看。
- **看的地方**：`/artifacts/<id>`（`?v=` 指定版本）：上面是标题、谁做的、版本切换、在新标签页打开原样、删；中间是这一版；旁边是这个产出在对话里的那几条（每版的卡片和对它们的回复），底下一个框直接回复最新那版。
- **工单详情**：多一块「产出」，列这张工单的产出。

### 安全：隔离着渲染

HTML 产出是别人写的页面，绝不能当农场自己的页面跑：

- 内容从 `GET /api/v1/artifact/<id>/<版本>` 给，响应带 `content-security-policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; form-action 'none'; base-uri 'none'`、`x-content-type-options: nosniff`。`sandbox` 不带 `allow-same-origin`，页面就是一个不透明的来源：读不到农场的 cookie 和存储，`connect-src 'none'` 让它连 `fetch` 都发不出去，打不到 127.0.0.1 上的接口。在新标签页单独打开也一样隔离（隔离写在响应头上，不只靠 iframe 的属性）。
- 页面用 `<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer">` 嵌它。
- Markdown 不进 iframe：原文当 `text/plain` 给，页面用自己的 Markdown 画（不认原始 HTML）。
- 「连接到本机」：和附件一样放行这条 GET，配对过的手机也能看。

### 存在哪

- 表：`artifact`（标题、种类、频道、工单、谁做的、当前版本、时间）和 `artifact_version`（第几版、sha、大小、这版改了什么、谁、时间、说它的那条消息）。
- 内容：`$VIBEVALLEY_HOME/artifacts/<sha256>`，同样的内容只存一份；删产出时没有别的版本用到的文件跟着删。

### 模块和接口

- 服务端新模块 `apps/server/src/artifact`（服务 `Artifacts`），归 Collaboration，排在 `channel`、`doc` 后面：它只用频道（说那句话）。工单只是它记的一个 id，按工单列出来不用 import 工单模块；会话所在的工单和串由工具那层（`tool`）给。
- 接口：`artifact.list`（按频道或工单）、`artifact.get`、`artifact.create`、`artifact.version.create`、`artifact.delete`（只有主人，带预演）。工具名照接口名来（`artifact_create`……），`file` 是只给 agent 的字段（`schemas.ts` 的 `agentOnly`）。
- 页面：`apps/web/src/features/artifact`（卡片、看的页面、工单里那一块），路由 `/artifacts/<id>`，不进左边的栏。

## Alternatives considered

- **放进附件，把 HTML 附件改成能在页面里看**：附件没有标题、版本，也说不清是谁为哪张工单做的；而且附件那条路由的安全规矩（HTML 一律下载）是对的，不该为了这个放松。
- **做成文档的一种块**：文档是大家一起一块一块写的，产出是一个人交出来、一版一版换的整页；塞进块里要给块加版本和沙箱，两边都变复杂。以后文档可以加一种「引用产出」的块。
- **用 srcdoc 把内容塞进 iframe**：内容要先经页面的脚本拿到再塞，且单独打开时没有响应头上的隔离；用自己的地址加响应头，iframe 和新标签页都隔离，还能缓存。
- **评论另开一张表**：回复消息已经有了，帮工也只会在对话里收到话；另开一套评论，帮工就要多学一个地方。
- **放到 claude.ai 或别的外部页面**：和工单、对话连不上，帮工收不到评论，「连接到本机」的手机也看不到。

## Acceptance criteria

- 帮工在一张工单上 `artifact_create` 一页 HTML（`content` 或工作目录里的 `file`），工单的串里出现它说的那句话和卡片；工单详情的「产出」里有它；`/artifacts/<id>` 能看到这一页。
- 新的一版：旧版还能切回去看；卡片说第几版、改了什么。
- 主人回复卡片，帮工被叫醒，`artifact_get` 读得到它要的那一版。
- 管家也能做，默认挂在它在回的频道。
- HTML 跑在不透明来源里：页面测试证明它读不到农场的存储、`fetch` 不出去；响应头带上面的策略；Markdown 不认原始 HTML。
- `file` 出不了工作目录（`..`、绝对路径、指向外面的符号链接都拒）；超过 5 MB、空的、种类不对、标题不对都拒，说为什么。
- 删产出要预演；删了以后只剩它的人没在用的内容文件跟着删。
- 配对的手机能看；`/mcp` 照旧不对外。
- 命令行能列、看、建、删；`docs/subsystems/artifact.md` 写好，这篇 Note 删掉。

## Risks

- **沙箱写错一处就是农场的来源**：响应头和 iframe 两层都要有，测试要真的在浏览器里证明读不到、发不出，不只比字符串。
- **外部脚本**：允许 `https:` 的脚本和样式，好让帮工用图表库；代价是产出能向外发请求（加载资源时带出参数）。它拿不到农场的任何东西，所以能泄露的只有产出自己的内容，接受。
- **管家多一个工具**：管家的工具表变了，录好的评测要重放（不花钱）；要真模型评测时先问主人。
- **大页面**：5 MB 的上限对内联图片的页面也许不够；先这样，真遇到再调。
