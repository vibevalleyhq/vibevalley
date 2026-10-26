# Skills

这里放这个项目自己的 skill：要 agent 判断、写不成代码或检查的做法（[AGENTS.md](AGENTS.md#怎么让-agent-做对) 的第 3 层）。`.claude/skills` 是指向这里的链接，Claude Code 和 Codex 读同一份。`vp run docs:verify` 查每个 skill 的格式，也查下面的表和目录对得上（[scripts/skills.ts](scripts/skills.ts)）。

验收（改完以后在真的程序上证明它对了）只有一个 skill：[acceptance](.agents/skills/acceptance/SKILL.md)。它的 `SKILL.md` 是入口，写共同的沙箱、证据和收拾，再按「改了什么」把 agent 指到同目录的一份分册（服务端、页面、手机壳、管家的评测），只读用得上的那份。新的一块照 [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) 加一份分册。

| skill | 什么时候用 | 证明什么 |
|---|---|---|
| [acceptance](.agents/skills/acceptance/SKILL.md) | 改了接口、服务、表结构、页面、手机壳、管家的提示之后，汇报之前 | 隔开的服务端起得来、接口和状态里有这次的改动、页面画对了、手机配得上；管家的评测用真模型重放（花钱，先问主人） |
| [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) | 一类改动没有现成的验收办法 | 给 acceptance 写出下一个 agent 照着就能做的一份分册 |
| [vv-pr](.agents/skills/vv-pr/SKILL.md) | 做完一件事要开 PR、改 PR、合 PR；手上几处改动不知道该合还是拆 | 切成几个 PR 是对的；分支名、英文的标题和正文合规矩、带着验收的证据；合之前 PR 上的标题和正文又查过一遍 |
| [vv-comments](.agents/skills/vv-comments/SKILL.md) | 写完代码提 PR 前；主人要清一块代码里的注释 | 留下的每条注释都是删了会让人写错的：模型初审、逐条对着代码核实过，删的删、改名的改名、改短的改短，模型判错的列出理由 |
| [vv-simplify](.agents/skills/vv-simplify/SKILL.md) | 想找一块代码里能简化的地方 | 一份核实过、排好序的清单：每处删掉什么、调用方少知道什么、靠哪个测试证明没变坏；主人点了再改 |
| [effect-ts](.agents/skills/effect-ts/SKILL.md) | 给一个用 Effect 的仓库做准备：装 `effect`、在 AGENTS.md 里指到它自带的 `AGENTS.md` 和源码（照抄自 [Effect-TS/skills](https://github.com/Effect-TS/skills/tree/main/skills/effect-ts)，不改） | 写 Effect 的 agent 先读 Effect 自己的指南，再查 `node_modules/effect/src` |
