# 代码风格

服务端（Go）、客户端（Dart）和它们的测试都照这一篇写。格式交给工具，本篇管工具管不到的：用什么叫法、注释写什么。

## 格式

- Go 用 `gofmt`，Dart 用 `dart format -l 160`，不手调。
- 工具管不到的（命名、文件里的先后、错误怎么说）照周围的代码。

## 叫法

- 代码、接口和服务端的文档用实际的概念：`Issue`、`Worker`、`Project`（[概念](../concepts.md)）。不用旧叫法 ticket，也不用网页时代的名字。
- 界面上的字用中文，用农场的叫法（[用语表](../README.md#用语)）。
- 注释用英文。

## 注释

注释只写不看它就会写错或改错的东西。代码自己能说清楚的，不写。

### 建议写

| 写什么 | 例子 |
|---|---|
| 为什么这样做 | `// A worktree with changes stays where it is: removing it would lose them.` |
| 顺序和锁 | `// Called with h.mu held.`<br>`// The steps first, so that the playbook is whole when its parent issue changes.` |
| 安全边界 | `// Only repository home URLs: never credentials, other git transports or command-line options.` |
| 格式、单位、取值，`nil`、`0`、`""` 的意思 | `// As the chat names it: <id>#<n>; "" when it has none.`<br>`// 0..1, 0.5 is noon.` |
| 要和别处保持一致的 | `// As Node's util.parseEnv: …`<br>`// A port of server/internal/protocol/voice.go: change them there and here together.` |
| 不显然的坑 | `// With one connection, a query outside the transaction while it is open would wait for ever.` |
| 生成器和工具的指令 | `//vibevalley:union _tag`、`//go:embed`、`// ignore: …` |
| 字段的可选值，写在行尾 | `Kind string // conflict, error` |

写成一两句，从这件事本身说起，不用「This function …」开头。

### 不建议写

| 不写什么 | 例子 |
|---|---|
| 照着名字或代码再说一遍 | `// Tell gives a helper words.`<br>`/// The tool in hand.` |
| 文件开头的功能概述 | `// The group chat (田头): the person, the manager and the helpers in one square …` |
| 给一段代码起标题、画分隔线 | `// ── Plots ──`<br>`// Everyone walks in from the gate.` |
| 测试里一步步讲在测什么 | `// No room yet: it waits.` |
| 历史和出处 | `// ported from the TypeScript server's crew.ts, removed`<br>`// as on the web page` |
| 别处的叫法 | CSS 类名（`focus-visible:ring-2`）、旧框架（Pixi、Base UI）、TS 的常量名（`QUOTA_LOW`） |
| 推理过程、行为说明 | 行为写进 [docs](../README.md)，理由写进 [Agent Note](../../.agents/notes/README.md) |

### 改代码时

- 注释和代码在同一个改动里改；说的事不再成立的注释，删掉或改对。
- 改了行为，先改文档；注释里不复述文档。
