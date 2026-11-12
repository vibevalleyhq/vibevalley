# Skills

这里放这个仓库自己的 skill：要 agent 判断、写不成代码或检查的做法（[AGENTS.md](AGENTS.md#怎么让-agent-做对) 的第 3 层）。`.claude/skills` 是指向这里的链接，Claude Code 和 Codex 读同一份。`vp run docs:verify` 查每个 skill 的格式，也查下面的表和目录对得上（[scripts/skills.ts](scripts/docs/skills.ts)）。

验收（改完以后在真的程序上证明它对了）只有一个 skill：[vv-acceptance](.agents/skills/vv-acceptance/SKILL.md)。它的 `SKILL.md` 是入口，写共同的沙箱、证据和收拾，再按「改了什么」把 agent 指到 `references/` 下的一份分册（服务端、页面、手机壳、桌面的更新、助手的评测），只读用得上的那份。新的一块照 [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) 加一份分册。

| skill | 什么时候用 | 证明什么 |
|---|---|---|
| [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) | 改了接口、服务、表结构、页面、手机壳、助手的提示之后，汇报之前 | 隔开的服务端起得来、接口和状态里有这次的改动、页面画对了、手机配得上；助手的评测用真模型重放（花钱，先问用户） |
| [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) | 一类改动没有现成的验收办法 | 给 vv-acceptance 写出下一个 agent 照着就能做的一份分册 |
| [vv-pr](.agents/skills/vv-pr/SKILL.md) | 做完一件事要开 PR、改 PR、合 PR；手上几处改动不知道该合还是拆 | 同批次尽量合成一个 PR；分支名、英文的标题和正文合规矩、带着验收的证据；合之前 PR 上的标题和正文又查过一遍 |
| [vv-comments](.agents/skills/vv-comments/SKILL.md) | 写完代码提 PR 前；用户要清一块代码里的注释 | 留下的每条注释都是删了会让人写错的：模型初审、逐条对着代码核实过，删的删、改名的改名、改短的改短，模型判错的列出理由 |
| [vv-simplify](.agents/skills/vv-simplify/SKILL.md) | 想找一块代码里能简化的地方 | 一份核实过、排好序的清单：每处删掉什么、调用方少知道什么、靠哪个测试证明没变坏；用户点了再改 |
| [vv-governance](.agents/skills/vv-governance/SKILL.md) | 要加一条规矩或一个检查；评审一块代码有没有在变坏；写计划前问清边界；做纯重构；一次机械的改动跨很多文件；用户提到白皮书、治理、五层金字塔、十条铁律 | 新检查用了最便宜的手段、失败时说得出怎么改；评审按六种病逐条查过；《AI 智能体时代的软件维护与工程治理白皮书》的每个要点在这里已有、已做、以后做还是不做，同目录的 `whitepaper.md` 逐条对照 |
| [vv-stylex](.agents/skills/vv-stylex/SKILL.md) | 写、改、评审原生 StyleX 样式；设计组件样式接口与 `.stylex.ts` 令牌；排查动态变量、条件、主题、marker、关键帧动画和 CSS 层顺序 | 样式沿用宿主令牌与 `tokens.stylex.ts`，经 Solid 对象样式边界组合，无工具类或编译期残留；门禁与生产编译一次通过 |
| [vv-tailwind](.agents/skills/vv-tailwind/SKILL.md) | 用 Tailwind v4 写、改、评审样式，把 StyleX 换成 class；令牌在 `style.css` 的 `@theme`、任意值什么时候可以、动态值、变体、零件收 `class`、迁移期间和 StyleX 并存 | class 只叫令牌的名字，lint（`design-tokens`、`no-hex-color`、`style-attrs`）一次通过，换前换后的截图对得上 |
| [vv-typescript](.agents/skills/vv-typescript/SKILL.md) | 写、改、评审服务端和各个包的 TypeScript（没有 Effect）；把还没改的 Effect 代码改写掉；评审一段异步代码（打断、收尾、并发、错误） | 服务是工厂加接口、依赖从参数进来；拒绝抛 ApiError；长操作收 AbortSignal、后台任务进 TaskGroup、资源用 await using；运行时校验只用 Zod；库只经生成的函数 |
| [vv-effect](.agents/skills/vv-effect/SKILL.md) | 写、改、评审用到 Effect 的代码；`effect:check` 报了 Effect 的诊断；不确定一个 API 在 v4 叫什么 | 照官方指南（`node_modules/effect/AGENTS.md`）和本仓库的约定写：服务、库、文件、时间、Promise 的交界、错误、命名、测试；评审时查出检查看不到的（错误的原因丢了、该说的错误变成了缺陷、fiber 不归服务的作用域） |
| [effect-ts](.agents/skills/effect-ts/SKILL.md) | 给一个用 Effect 的仓库做准备：装 `effect`、在 AGENTS.md 里指到它自带的 `AGENTS.md` 和源码（照抄自 [Effect-TS/skills](https://github.com/Effect-TS/skills/tree/main/skills/effect-ts)，不改） | 写 Effect 的 agent 先读 Effect 自己的指南，再查 `node_modules/effect/src` |
