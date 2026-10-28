# 产出

产出（artifact）是管家、帮工或主人交出来的一页：一整页 HTML，或一段 Markdown，有标题、有版本，挂在它被说出来的那个频道或工单的串里，在工作台里隔离着看。两种设计让主人挑、调研报告、对比表、带图的说明，都是产出。

## 管什么，不管什么

- 管：产出和它的每一版、存它们的内容、说它们的那句话和卡片、给页面看的那条路、帮工和管家的工具。
- 不管：评论。评论就是回复那张卡片的消息（[频道](docs/subsystems/channel.md)），帮工照常被叫醒。
- 不管：图片、PDF 这类文件。它们是消息的附件，HTML 附件照旧只能下载，不在页面里跑。
- 不管：写一页。主人在页面上不写产出，只看、回复、删；帮工和管家写好了交上来。

## 在哪

- 服务端 `apps/server/src/artifact`（服务 `Artifacts`），归 Collaboration，排在 `channel`、`doc` 后面；`rules.ts` 是校验和内容的响应头。
- 表 `artifact`、`artifact_version`；内容在 `$VIBEVALLEY_HOME/artifacts/<sha256>`。
- 接口 `artifact.list`、`artifact.get`、`artifact.content.get`、`artifact.create`、`artifact.version.create`、`artifact.delete`（带预演，只有主人），见 [capabilities.md](docs/reference/capabilities.md)；工具名照接口名来（`artifact_create`……）。
- 内容：`GET /api/v1/artifact/<id>/<版本>`（`http/artifact.ts`，`artifactPath`）。
- 频道：`Channels.announce` 以作者的身份说那句带卡片的话，`Channels.placeOf` 把「在哪说」认成频道。
- 页面 `apps/web/src/features/artifact`：消息里的卡片（`ArtifactCard`）、看的页面（`/artifacts/<id>`，`?v=` 指定版本，不进左边的栏）、工单详情里的「产出」（`IssueArtifacts`）；田头窗口的卡片点开去工作台看。

## 模型和不变量

- 一个产出：标题（1 到 80 个字）、种类（`html`、`markdown`）、在哪说的（频道或串）、为哪张工单（可选）、谁做的、最新是第几版。
- 一版至多 5 MB，内容做好就不再变，按 sha256 存一份；新的一版不覆盖旧的。
- 每一版都由做它的人在第一版说过的地方说一句，消息的元数据带着卡片（`ChatMessage.artifact`：那时的标题、种类、第几版、这版改了什么）。这一版记着那条消息，它的评论就是对那条消息的回复。
- 帮工读消息时，带卡片的那条多一行「产出……id=…」，照它读原文。
- HTML 的内容永远不当农场自己的页面跑：响应头的 `content-security-policy` 是 `sandbox`（不带 `allow-same-origin`）加 `connect-src 'none'`，iframe 的 `sandbox` 属性也一样。它拿不到农场的 cookie 和存储，`fetch` 发不出去；脚本、样式、图、字体可以内联或来自 https。在新标签页单独打开也一样隔离。
- Markdown 的原文当 `text/plain` 给，页面用自己的 Markdown 画，原始 HTML 丢掉。
- 帮工交 `file` 时，服务端只读它工作目录里面的文件：路径连着符号链接一起解开，出了目录就拒。

## 怎么走

**做一个**：帮工调 `artifact_create`（`content` 或 `file`）→ 校验 → 存内容 → 在它的工单串里以它的名义说「做了「标题」」带卡片 → 记下产出、第一版和那条消息。管家的默认在它正在回的频道，主人的默认在默认频道。

**出新的一版**：`artifact_version_create` → 在第一版说过的地方再说一句带卡片的话 → 记下这一版。

**看**：主人点卡片 → `/artifacts/<id>?v=<版本>`：上面是标题、谁做的、在新标签页打开、删；中间是这一版；旁边是每一版（谁、什么时候、改了什么）、回到对话里那条消息，和一个框回复正在看的这一版。页面每几秒读一次，新的一版自己出来。

**删**：主人删一个产出 → 它和它的每一版没了，没有别的版本用到的内容文件跟着删；对话里的卡片还在，点开说已经删掉了。

## 和谁打交道

- 用 [频道](docs/subsystems/channel.md)：在哪说、说那句话；回复是频道的事。
- 被工具（`tool`）用：会话的工单和工作目录由工具那层给，产出模块只记工单的 id。
- 「连接到本机」（[连接到本机](docs/subsystems/lan.md)）像附件一样放行内容的 GET，配对的手机也能看；`/mcp` 照旧不对外。

## 为什么这样

- **不放进附件，也不把 HTML 附件改成能在页面里看。** 附件没有标题和版本，也说不清是谁为哪张工单做的；附件那条路由「HTML 一律下载」的规矩是对的，不为它放松。
- **不做成文档的一种块。** 文档是大家一起一块一块写的，产出是一个人交出来、一版一版换的整页；塞进块里要给块加版本和沙箱。
- **用自己的地址加响应头，不用 srcdoc。** srcdoc 要先经页面的脚本拿到内容再塞，单独打开时也没有响应头上的隔离；用地址，iframe 和新标签页都隔离，还能缓存。
- **评论就是回复卡片。** 帮工只会在对话里收到话；另开一套评论，它就要多学一个地方。
- **允许 https 的脚本和样式。** 好让帮工用图表库；代价是产出能向外发请求。它拿不到农场的任何东西，能泄露的只有它自己的内容。
- **不放到 VibeValley 外面（本机的文件、claude.ai 的页面）。** 那样和工单、对话连不上，帮工收不到评论，配对的手机也看不到。

## 怎么验证

- `apps/server/src/artifact/rules.test.ts`：校验和响应头（沙箱不带 `allow-same-origin`，`connect-src 'none'`）。
- `apps/server/src/artifact/artifact.test.ts`：卡片说在哪、新的一版留着旧的、按工单和频道列、拒绝的几种、删掉以后内容文件的去留。
- `apps/server/src/http/artifact.test.ts`：内容的响应头、404、「连接到本机」放行。
- `apps/server/src/mcp/mcp.test.ts`：帮工从工作目录交一个文件，挂在它的工单和串上；`..`、绝对路径、目录、指向外面的符号链接都拒。
- `apps/web/test/artifact.spec.ts`：在真的浏览器里证明页面读不到存储、碰不到外层、`fetch` 发不出；卡片、版本、回复、删；Markdown 不认原始 HTML；工单里的「产出」。
