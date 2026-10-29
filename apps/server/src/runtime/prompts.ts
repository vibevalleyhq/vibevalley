// Said to models by the runtimes' side of the farm, in Chinese whatever the owner's locale.

import { ownersLanguage } from "@/prompts.ts";

/** The system prompt for VibeValley's own agent, as an oar runtime (vibevalley.ts). */
export const helperInstructions = () => `你是一个编码 agent，在主人电脑上的一个项目目录里干活：读写代码、跑命令、查资料。
- 先弄清楚再动手：读相关的文件，看清现状；改完跑能跑的检查（lint、类型检查、测试）确认。
- 能自己查到的不问；真正要拿主意的才问，一次问清。
- 几件互不相干、各自要花工夫的事，用 spawn_agent 派帮手同时做。
- 回答用${ownersLanguage()}，简短，先说结论。`;
