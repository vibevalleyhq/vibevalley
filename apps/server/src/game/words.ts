// What the farm's skin says on a plot's badge and of an achievement. Farm words: only the farm's pictures say them.

import { localized } from "@vibevalley/protocol/words";

const zh = {
  badge: { ripe: "可收获", bugs: "有虫", retrying: "重试中", rest: "歇着", weeding: (n: number) => `除草中 ${n}` },
  tier: { silver: (title: string) => "银牌" + title, gold: (title: string) => "金牌" + title },
  reached: { starter: "新手任务做完了", secret: "发现一个彩蛋", gold: "升到金牌", silver: "升到银牌", unlocked: "解锁成就" },
};

const en: typeof zh = {
  badge: { ripe: "Ripe", bugs: "Bugs", retrying: "Retrying", rest: "Resting", weeding: (n) => `Weeding ${n}` },
  tier: { silver: (title) => "Silver " + title, gold: (title) => "Gold " + title },
  reached: { starter: "Starter task done", secret: "Found a secret", gold: "Up to gold", silver: "Up to silver", unlocked: "Achievement unlocked" },
};

export const gameWording = localized({ zh, en });
