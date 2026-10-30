# 代码风格

服务端（`apps/server`）、页面（`apps/web`）、宿主（`apps/desktop`、`apps/mobile`）、共用包和它们的测试都照这一篇写。格式交给工具，本篇管工具管不到的：用什么叫法、注释写什么；名字怎么起见 [naming.md](docs/style/naming.md)。

## 格式

- 格式交给 oxfmt（`vp check --fix`，160 列，设置在根目录 `vite.config.ts`），lint 交给 oxlint（`vp check`），不手调；Markdown 不排，表格照写成 `|---|`。
- import 由 oxfmt 排成五组，从远到近：Node、外面的包、`@vibevalley/*`、本 app 的 `@/`、同目录；Tailwind 的类照 Tailwind 自己的顺序（读 `apps/web/src/style.css`，`cx(…)` 里的也排）。文件开头的说明注释在 import 上面。
- 提交钩子和 CI 一样跑 `vp check --fix --deny-warnings`：警告也挡提交。
- 工具管不到的（文件里的先后、错误怎么说）照周围的代码；命名照 [naming.md](docs/style/naming.md)。
- 注释里认得出来的交给 lint：分隔线和给一段代码起的标题（`vibevalley/no-comment-divider`）；认不出来的（换个说法复述名字、概述、测试里一步步讲），`vpx scripts/comment-review.ts` 让模型照下面「注释」一节审这个分支新加的注释（`--all <目录>` 审一块已有的），只报不改，怎么核实、删改照 [vv-comments](.agents/skills/vv-comments/SKILL.md)（[理由](docs/subsystems/process.md#为什么这样)）。

## 叫法

- 代码、接口和服务端的文档用实际的概念：`Issue`、`Session`、`Project`（[概念](docs/concepts.md)）。不用旧叫法 ticket，也不用网页时代的名字。
- 对主人说的话写进词典（`packages/i18n/locales`），中英各一份，代码里写 `t("key")`；对模型说的写进 `prompts.ts`，用中文（[话放在哪](docs/subsystems/foundation.md#话放在哪)）。用农场的叫法（[用语表](docs/README.md#用语)）。
- 注释用英文。

## 没有值

「没有」只有一种写法在自己的代码里流动；外面带进来的 `null` 在进门处换掉。

| 写法 | 什么时候 | 例子 |
|---|---|---|
| 必有的字段，给默认值 | 没有和「空」是一回事：列表 `[]`、表 `{}`、开关 `false`、说给人看的字 `""` | `mentions: []`、`description: ""`、`problem: ""`（`xProblem` 没问题就是 `""`） |
| `x?: T`（不写） | 没有本身就是一种情况：没跑过就没有 `lastRun`，没连到别处就没有 `project`、`channel`；请求里不写就是不改；宿主没有这项本事就没有 `notify` | `lastRun?: LastRun`、`IssueUpdate.title?` |
| `x: T \| undefined` | 内存里会被清空的状态（类的字段、一次运行的记录）；查找没找到 | `sess: OarSession \| undefined`、`Map.get` |
| `null` | 只在外面说 `null` 的地方：库表的列（`db/generated`）、DOM 和浏览器的接口、JSX 什么都不画；线上只有「问过、没答案」用它，和「答了、是空」分开 | `models: ModelEntry[] \| null`（农机没列出来） |

- 不写 `T | null | undefined`：外面来的 `null` 在进门的那一处换成 `undefined`（`jsonOrNone`、`?? undefined`），里面只认一种。
- 读必有的字段不写 `?? []`、`?.`：类型说它在，它就在。从外面读进来（老的存档、测试的黄金数据、外面库的返回）类型说不准的，在读进来的那一处补齐，不在用的地方兜。
- 必有的字放 `""` 以后，「没有就用别的」写 `||`，不写 `??`：`n.conclusion || "做完了"`。数字和布尔不这样：`0`、`false` 是值，写 `??`（lint 的 `prefer-nullish-coalescing` 查）。
- 条件里只放布尔和字符串（`""` 是没有）：数字写 `n > 0`、`n !== 0`，可能没有的布尔写 `=== true`，可能没有的对象直接判（lint 的 `strict-boolean-expressions` 查）。比较函数一层层比，写 `or(…)`（`apps/server/src/base/order.ts`、`apps/web/src/base/order.ts`），不写 `a - b || …`。
- 给人看的话只在帧上：核心形状（`Session`、`Cron`、`Doing`）只有事实，帧用视图形状（`SessionView`、`CronView`、`WorkspaceView`）带上必有的说法；读说法的函数收视图形状，只读事实的收核心形状（视图形状能当核心形状用）。
- 闭合的一组词在库里是枚举类型（`<表>_<列>`，`schema.test.ts` 查），生成的查询读出来就是词的联合；从字符串认一个词用 `isOneOf`，按 `_tag`、`kind` 取联合里的一种用 `variant`（页面），都不写 `as`。

## 检查管着的写法

- 不写收窄的 `as`：外面来的值用 Schema 或类型守卫读，DOM 的值用 `instanceof`；确实只能断言的（库的类型缺口、自己写出又读回的文件），在那一行写 `// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- <为什么成立>`。测试、故事和样例不查：断言错了，读它的断言会失败。
- 全局的属性是两个世界之间的契约（页面和它的壳、测试和它起的程序）：在门里声明一次（`declare global`、`interface Window`），之后按名字带着类型读写。门只有三个：`packages/protocol/src/host.ts`（宿主）、`apps/desktop/src/probe.ts`（桌面测试读的探针，只在 `VIBEVALLEY_DESKTOP_PROBE=1` 时有）、`apps/web/test/marks.ts`（页面测试自己埋的点）；转型 `window`、`globalThis`，`Object.assign` 到它们上，门外的 `declare global`，lint 的 `vibevalley/global-doors` 拦。
- 正则都带 `u`：中文和 emoji 按码点算，`.`、`[^x]` 不会切开一个字。
- 不就地排序、倒序：`toSorted`、`toReversed`，帧和核心状态是共享的。
- 循环里的 `await`：彼此无关的改成 `Promise.all`；一步要等上一步的（轮询、分页的游标、一个会话的轮次、按次序的批）在那一行写明为什么。Playwright 的测试不查：一页只能一步步点。

## 注释

注释只写不看它就会写错或改错的东西。代码自己能说清楚的，不写。

### 建议写

| 写什么 | 例子 |
|---|---|
| 为什么这样做 | `// A worktree with changes stays where it is: removing it would lose them.` |
| 顺序和锁 | `// Inside the semaphore: one merge per project at a time.`<br>`// The tasks first, so that the graph is whole when its parent issue changes.` |
| 安全边界 | `// Only repository home URLs: never credentials, other git transports or command-line options.` |
| 格式、单位、取值，`null`、`0`、`""` 的意思 | `// As the chat names it: <id>#<n>; "" when it has none.`<br>`// 0..1, 0.5 is noon.` |
| 要和别处保持一致的 | `// As Node's util.parseEnv: …`<br>`// As keyBetween in packages/protocol: change them there and here together.` |
| 不显然的坑 | `// With one connection, a query outside the transaction while it is open would wait for ever.` |
| 生成器和工具的指令 | `// @ts-expect-error …`、`/** @internal */` |
| 字段的可选值，写在行尾 | `kind: string // conflict, error` |

写成一两句，从这件事本身说起，不用「This function …」开头。

### 不建议写

| 不写什么 | 例子 |
|---|---|
| 照着名字或代码再说一遍 | `// tell gives a session words.`<br>`/** The tool in hand. */` |
| 文件开头的功能概述 | `// The group chat (频道): the person, the orchestrator and the helpers in one square …` |
| 给一段代码起标题、画分隔线 | `// ── Plots ──`<br>`// Everyone walks in from the gate.` |
| 测试里一步步讲在测什么 | `// No room yet: it waits.` |
| 历史和出处 | `// ported from the Go server's session.go`<br>`// as on the web page` |
| 别处的叫法 | CSS 类名（`focus-visible:ring-2`）、旧框架（Pixi、Base UI）、别的语言的常量写法（`QUOTA_LOW`） |
| 推理过程、行为说明 | 行为写进 [docs](docs/README.md)，理由写进 [Agent Note](.agents/notes/README.md) |

### 改代码时

- 注释和代码在同一个改动里改；说的事不再成立的注释，删掉或改对。
- 改了行为，先改文档；注释里不复述文档。
