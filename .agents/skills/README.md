# Skills

这里放这个仓库自己的 skill：要 agent 判断、写不成代码或检查的做法（[AGENTS.md](AGENTS.md#怎么让-agent-做对) 的第 3 层）。`.claude/skills` 是指向这里的链接，Claude Code 和 Codex 读同一份。`vp run docs:verify` 查每个 skill 的格式，也查下面的表和目录对得上（[scripts/skills.ts](scripts/docs/skills.ts)）。

验收（改完以后在真的程序上证明它对了）只有一个 skill：[vv-acceptance](.agents/skills/vv-acceptance/SKILL.md)。它的 `SKILL.md` 是入口，写共同的沙箱、证据和收拾，再按「改了什么」把 agent 指到 `references/` 下的一份分册（服务端、应用、媒体），只读用得上的那份。新的一块照 [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) 加一份分册。

| skill | 什么时候用 | 证明什么 |
|---|---|---|
| [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) | 改了接口、服务、表结构、页面、像素场景之后，汇报之前 | 隔开的 Rust 服务端起得来、接口和状态里有这次的改动；隔开的原生应用里页面和像素场景画对了 |
| [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) | 一类改动没有现成的验收办法 | 给 vv-acceptance 写出下一个 agent 照着就能做的一份分册 |
| [vv-pr](.agents/skills/vv-pr/SKILL.md) | 做完一件事要开 PR、改 PR、合 PR；手上几处改动不知道该合还是拆 | 同批次尽量合成一个 PR；分支名、英文的标题和正文合规矩、带着验收的证据；合之前 PR 上的标题和正文又查过一遍 |
| [vv-comments](.agents/skills/vv-comments/SKILL.md) | 写完代码提 PR 前；用户要清一块代码里的注释 | 留下的每条注释都是删了会让人写错的：模型初审、逐条对着代码核实过，删的删、改名的改名、改短的改短，模型判错的列出理由 |
| [vv-simplify](.agents/skills/vv-simplify/SKILL.md) | 想找一块代码里能简化的地方 | 一份核实过、排好序的清单：每处删掉什么、调用方少知道什么、靠哪个测试证明没变坏；用户点了再改 |
| [vv-governance](.agents/skills/vv-governance/SKILL.md) | 要加一条规矩或一个检查；评审一块代码有没有在变坏；写计划前问清边界；做纯重构；一次机械的改动跨很多文件；用户提到白皮书、治理、五层金字塔、十条铁律 | 新检查用了最便宜的手段、失败时说得出怎么改；评审按六种病逐条查过；《AI 智能体时代的软件维护与工程治理白皮书》的每个要点在这里已有、已做、以后做还是不做，同目录的 `whitepaper.md` 逐条对照 |
| [vv-arch-loop](.agents/skills/vv-arch-loop/SKILL.md) | 做跨模块架构重构、拆大文件、清锁热点/DAG 环/并发债，或按分析器跑一轮重构闭环 | 跑过诊断→分诊→修复→验证→棘轮五步：`cargo xtask diagnose --json` 前后读数改善、对应门禁全绿、`xtask` 天花板与 `clippy.toml` 已锁紧到新水位 |
| [vv-tailwind](.agents/skills/vv-tailwind/SKILL.md) | 写、改、评审工作台（nsh 的 Tailwind class）和官网（Tailwind v4）的样式：令牌在哪、半透明和动态的值、变体、零件收 `class` | class 只叫令牌的名字，字的样式在 `Text` 上，换前换后的截图对得上 |
| [vv-typescript](.agents/skills/vv-typescript/SKILL.md) | 写、改、评审原生应用的页面、官网和各个包的 TypeScript；评审一段异步代码（打断、收尾、并发、错误） | 拒绝是 ApiError；长操作收 AbortSignal、不留没人等的 Promise；运行时校验只用 Zod |
