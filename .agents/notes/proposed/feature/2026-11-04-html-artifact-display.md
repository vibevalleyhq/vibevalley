# Agent Note: 网页稿子照 porthole 的思路：一份显示规格、交之前查、页面里的锚点、划词改字

Status: proposed

## Problem

网页稿子（[稿子](docs/subsystems/artifact.md)，`html`）是帮工写的一整页，在沙箱里显示。现在它能做什么写在四处，互相不知道：

- 服务端的响应头（`apps/server/src/artifact/policy.ts` 的 `htmlPolicy`：sandbox 加 CSP）；
- 页面上 iframe 的 `sandbox` 属性，抄了两份（`features/artifact/ArtifactsPage.tsx`、`ArtifactCanvas.tsx`）；
- 帮工的工具说明（`tool/prompts.ts` 的 `artifact.create`）：一句也没说页面不能联网、能从哪里加载库、多大，帮工交上来页面坏了才知道；
- 交上来的时候什么都不查，只看大小。

另外：`script-src`、`img-src` 等放行任何 `https:`，页面一打开就能往任何地方发请求（带上什么时候、被看了几次）。主人想说「这里改一下」只能用字描述是哪里；改一个错字也要叫帮工再出一版。

[porthole](https://github.com/botiverse/porthole)（和 oar 同一个组织，给宿主安全地显示 agent 写的 HTML）把这件事想得很透：隔离要几层一起对上（内容的 CSP、iframe 的 sandbox、宿主自己的 CSP、frame 里的外壳、给 agent 的说明），所以一份配置同时生成服务端的路由、页面的 iframe、CSP 和给 agent 的说明；显示之前先查（`admitContent`、`lintContent`）；frame 里的外壳给出 W3C 选择器式的锚点，宿主据此画评论标记；宿主从不改 frame 里的 DOM，内容只整篇替换。主人决定不用这个库（1.0 之前、API 会变、只有 React 的绑定、我们只要其中一小部分），照它的思路做我们自己的。

## Proposal

### 1. 一份显示规格

网页稿子能做什么只写一次，别处都从它来：

- `packages/protocol/src/rules/display.ts`：iframe 的 `sandbox` 取值（`allow-scripts allow-popups allow-popups-to-escape-sandbox`，永远不带 `allow-same-origin`）。服务端的响应头和页面的两个 iframe 都用它；页面不再自己写一份。
- `apps/server/src/artifact/policy.ts`：CSP 由一张**放行的来源表**拼出来：脚本和样式只来自 `cdn.jsdelivr.net`、`cdnjs.cloudflare.com`，字体只来自 `fonts.googleapis.com`、`fonts.gstatic.com`，图和媒体只是 `data:`、`blob:`；`connect-src`、`form-action`、`frame-src` 是 `'none'`。不再放行任何 `https:`。
- 帮工的说明（`artifact.create`、`artifact.version.create` 的描述）由同一张表写出：页面不能联网、能从哪几个地方加载库和字体、图要内联、多大。

### 2. 交之前查

`artifact/check.ts`（纯函数，服务端）：用 HTML 解析器（`parse5`）读一遍，对着放行的来源表查：

- **拒绝**（说清哪一行、怎么改）：表外的 `<script src>`、`<link href>`、`<img src>`、CSS 里的 `url()` 和 `@import`；`<form action>`、`<meta http-equiv="refresh">`、`<base href>`、嵌套的 `<iframe>`；超过大小。
- **提醒**（交得上，回答里带着）：脚本里出现 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`（CSP 会挡住，页面这部分不会动）。

`artifact.create`、`artifact.version.create` 先过它；工具的回答把拒绝和提醒原样给帮工，它改了再交。

### 3. 页面里的锚点

照 W3C 的 Web Annotation 选择器，锚点有两种：

- **一段字**：`{ kind: "text", exact, prefix, suffix }`（TextQuoteSelector：原文和前后各 32 个字）；
- **一个元素**：`{ kind: "element", css }`（CssSelector）。

形状 `HtmlAnchor` 在 protocol。服务端看网页的一版时，可以要一份带**外壳脚本**的（`GET /api/v1/artifact/<id>/<版本>?shell=1`；存下的版本里没有它，换的只是这一次给出的字节）。外壳只做四件事：

- 主人划一段字（或在挑元素时点一个元素），把锚点经 `postMessage` 交给工作台；
- 按工作台给的锚点画标记（带数），点标记告诉工作台；
- 把一个锚点滚到眼前、闪一下；
- 回报页面的高度（以后在聊天的卡片里直接显示用）。

工作台只听这个 iframe 发来的、格式对的消息，并且只当数据：外壳和页面自己的脚本在同一个 frame 里，页面能伪造消息，所以外壳说的话不给任何权力。存一版永远是主人点了按钮，内容由服务端照锚点改源码得出，不是 frame 交来的。

### 4. 划词改字

主人在页面里划一段字 → 旁注里出现「改成…」，带着原文 → 存的时候调 `artifact.html.edit`（`{ id, version, anchor, text }`）→ 服务端 `artifact/edit.ts`（纯函数）：

- 在源码里**可见的字**中找锚点：跳过 `<script>`、`<style>`、注释和属性，相邻的文字节点连起来找，`exact` 加前后文唯一对上；
- 只把那段字换掉，源码的其余字节原样不动，存成新的一版，记一句「主人在页面上改了：『旧』→『新』」；
- 找不到（脚本画出来的字）、对上不止一处、跨了带标签的元素时拒绝，说为什么，并给「交给帮工改」的出路。

改样式、改结构不在这里：点元素得到锚点，评论交给帮工改。

### 5. 先做哪些

1. 一份显示规格（第 1 节）和交之前查（第 2 节）：只动服务端、两个 iframe 和工具说明，帮工交的页面马上更安全、更少交坏。已做，沉淀在 [稿子](docs/subsystems/artifact.md)。
2. 外壳和锚点（第 3 节）加划词改字（第 4 节）：稿子页的旁注里出「改成…」。已做文字锚点和划词改字，沉淀在 [稿子](docs/subsystems/artifact.md)；点元素、画标记、滚到眼前、回报高度跟第 3 步一起做。
3. 评论钉在锚点上、标记带数：等「每篇稿子一个串」做了再接上（评论是串里带锚点的消息）。
4. （以后）边写边显示、读农场数据的实时页面：要单独的内容来源（本机 `content.localhost`），手机经「连接到本机」时退回不透明的 iframe。

## Alternatives considered

- **用 porthole 这个库。** 隔离、泄漏测试、锚点都现成；但它在 1.0 之前、小版本会改 API，页面绑定只有 React，服务端的那一套为单独的内容域名设计，我们只用到其中一小部分。主人决定只借思路。
- **照 porthole 做两层 frame**（外壳在外层、页面在里层的不透明来源）：外壳的消息页面伪造不了。我们的外壳说的话本来就不给权力（存版本要主人点、改源码由服务端照锚点做），一层够用；以后要让页面经外壳用农场的服务（实时页面）时再分两层。
- **改字时把页面现在的 DOM 存成新的一版。** 脚本画出来的东西也会被存进去，下次打开再画一遍就重复了；改源码才对。
- **给每个元素注入编号属性再按编号改。** 要改页面的字节，编号随版本变；W3C 的文字锚点是标准的，换了版本只要字还在就还对得上。
- **继续放行任何 https。** 帮工写页面更自由；但页面能往外发请求，主人看一眼就被记下。放行的表外的库，检查会说怎么改（换到 jsdelivr 或 cdnjs，或者内联）。

## Acceptance criteria

- `sandbox` 的取值只在 `rules/display.ts`：服务端的头和两个 iframe 都从它来（lint 或测试拦住别处再写一份）；帮工的说明和检查都从同一张放行表来（测试对比描述里列的来源和表）。
- 交一页从表外加载脚本、表单提交到外面的，被拒，回答说哪一行、怎么改；一页 `fetch` 外面的，交得上、带提醒。
- e2e：一页里 `<img src="https://example.com/x.png">`（经测试的种子直接写库，绕过检查）在工作台里加载不了；划一段字、改成别的、存，新的一版里换了那段，其余字节一样，旧的一版还在。
- `artifact/check.ts`、`artifact/edit.ts` 的纯函数测试：每种拒绝和提醒；改字的唯一对上、前后文区分、跨元素拒绝、脚本里的字不算。
- `vp check`、`server:check`、`web:check`、`docs:verify`；[稿子](docs/subsystems/artifact.md) 照新的样子改。

## Risks

- **放行表太窄**：帮工用惯的库不在表上。检查的拒绝里说可用的来源；表在一处，要加一个来源只改一行，说明和检查跟着变。
- **改字对不上**：同一段字出现多次时靠前后文；对不上就拒绝，不猜。
- **外壳和页面的脚本打架**：外壳用自己的名字空间、只听 `message` 和选区事件；页面把选区事件吞掉时划词改字不可用，评论和交给帮工照旧可用。
