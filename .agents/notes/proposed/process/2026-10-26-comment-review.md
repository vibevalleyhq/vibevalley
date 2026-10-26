# Agent Note: 没价值的注释：静态规则挡分隔线，模型审改动里新加的注释

Status: proposed

## Problem

[代码风格](docs/style/code.md#注释)写了注释该写什么、不该写什么，但只是文字：agent 照着已有的代码抄，看到 `// ── reading ──` 就再写一个，看到 `/** The configuration, as a service. */` 就给下一个类也配一句。按[怎么让 agent 做对](AGENTS.md#怎么让-agent-做对)的次序，这类问题该先交给检查，文字排在后面。

量过一遍现有的注释（2026-10-26 的 main，`apps`、`packages`、`scripts` 下 571 个文件、4663 条注释），看哪些能靠静态规则认出来：

| 试的规则 | 命中 | 准不准 |
|---|---|---|
| 分隔线、给一段代码起标题：`// ── reading ──` | 40 | 全是，正是不建议写的那一行 |
| 注释里有中文 | 198 | 几乎都在引界面上的词（田头、接着修），该留 |
| 历史的说法（no longer、previously、ported from） | 16 | no longer 多半在说现在的状态，准不了 |
| 注掉的代码 | 0 | 没有这种问题 |
| 照名字再说一遍（注释的词都在下一行的标识符里） | 29 | 一半左右：`/** SeenUpTo. */` 是，`/** A number in [0, 1) and the next seed. */` 不是 |
| 同上，只比声明的名字 | 1 | 准，但只抓到 `/** SeenUpTo. */` |
| 文件开头的概述 | 28 | 多半夹着为什么，要逐条判断 |

能确定地认出来的只有分隔线。其余的（换个说法复述名字、文件开头的概述、测试里一步步讲、行为说明）要读懂注释和它旁边的代码才判断得了，词表和正则做不到。

## Proposal

两层：认得准的交给 lint，要读懂的交给模型，只审这个分支新加的注释。

### lint：`vibevalley/no-comment-divider`

写在 [scripts/oxlint-plugin.ts](scripts/oxlint-plugin.ts)，`vp check` 里跑，`error`。认的是注释里成串的横线字符（`──`、`━━`、`══`），和整条只有 `-=*#~_` 这类符号的注释。同一个改动删掉现有的 40 处：只是标题的删掉，夹着为什么、顺序、要和别处一致的，改写成一句普通的注释留下。

### 模型：`scripts/comment-review.ts`

```bash
vpx scripts/comment-review.ts                     # 这个分支（含没提交的）比 main 新加的注释
vpx scripts/comment-review.ts --all <路径>...     # 这些路径下已有的全部注释，清一块用
vpx scripts/comment-review.ts --dry-run           # 只数要审的注释和请求的大小，不调模型
```

- **审哪些**：和 main 的分叉点比，`git diff -U0` 里新加的行落在哪条注释上，就审哪条；连着的几行 `//` 算一条。工具的指令（`@ts-expect-error`、`oxlint-disable`、`@internal`、`#__PURE__`）不审。注释由 oxc 的解析器（`vite` 的 `parseSync`）找，字符串里的 `//` 不算。
- **照什么审**：每次从 [docs/style/code.md](docs/style/code.md#注释) 读「注释」那一节原样放进提示，规矩只有那一份；改了规矩，审的标准跟着变。
- **给模型看什么**：文件路径、注释、它前面几行和后面它说的那段代码。
- **模型说什么**：每条 `keep`、`delete` 或 `rewrite`，对上表里的哪一行，一句理由；`rewrite` 附改好的写法。有不是 `keep` 的，退出码 1。
- **哪个模型**：DeepSeek 的 `deepseek-flash`（和管家同一个），钥匙读 `DEEPSEEK_API_KEY`；直接 `fetch` 它兼容 OpenAI 的接口，脚本不依赖服务端的包。一个改了几十条注释的分支，一次几万 token，不到一分钱。
- **测试**：找注释、拼提示、读模型的回答是纯函数，`scripts/comment-review.test.ts` 用假的模型测；真调模型要花钱，不进 `scripts:test`。
- **在哪跑**：提 PR 前在本机跑（[AGENTS.md](AGENTS.md#命令) 的命令里一行），不进 CI：模型的回答每次不一样，不该挡合并，CI 也不用配钥匙。

### skill：`vv-comments`

模型只读了注释附近的十几行，会判错；改不改由写代码的 agent 对着代码定。[vv-comments](.agents/skills/vv-comments/SKILL.md) 写怎么定：定范围（新加的，或主人点的一块）、先 `--dry-run` 数、跑、逐条问「删掉它改这段的人会写错什么」，偏向删，能让名字或类型说的改名字或类型，模型判错的留下并列出来。[vv-pr](.agents/skills/vv-pr/SKILL.md) 推之前指到它。

## Alternatives considered

- **只靠文字（skill、本文）**：现在就是这样，挡不住照着抄。
- **全部写成 lint**：上面量过，复述名字、概述这几类正则认不准，`error` 会误报，`warn` 没人看。
- **每次审整个仓库**：3850 条注释（连着的 `//` 合成一条以后），近两百次请求，慢、结果每次不一样；默认只审新加的，花的和改动一样大，旧的由主人点名一块用 `--all` 清，或由碰到它的改动顺手处理（[改代码时](docs/style/code.md#改代码时)）。
- **让模型直接删**：判断会错，删错一条说「为什么」的注释比留一条废话代价大；它只报，改不改由写代码的 agent 看过再定。

## Acceptance criteria

- `vp check` 对一条 `// ── x ──` 报 `vibevalley/no-comment-divider`；main 上现有的 40 处已经处理，`vp check --deny-warnings` 过。
- `scripts/comment-review.test.ts` 在 `vp run scripts:test` 里过：只挑出新加的注释、连着的 `//` 合成一条、跳过指令、模型漏答或答错格式时报错而不是当成 `keep`。
- `--dry-run` 在这个分支上列出新加的注释。
- 在真的分支上跑过：本分支新加的 16 条注释（改写的三条、两个脚本的），模型全判 `keep`，和人的判断一致，没有误报。
- 还差一次校准：拿已知该删的注释（`docs/style/code.md` 不建议写的例子、量出来的「照名字再说一遍」和文件开头概述）跑一遍，看它漏掉多少。

## Risks

- **模型判错**：只报不改；理由要指到表里的一行，看得出它依据什么。
- **每次结果不一样**：所以不进 CI。以后要在 PR 上挂评论（不挡合并），CI 要配 DeepSeek 的钥匙。
- **规矩改了标准就变**：这是有意的，提示里的规矩就是 `docs/style/code.md`。
