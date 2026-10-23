// The orchestrator's looks and the pets the owner can pick (data/prefs.ts keeps the choice), and their sprites.

/** The orchestrator's looks: sprite orchestrator-<id>, the plain one is farmer. */
export const orchestratorLooks: readonly { readonly id: string; readonly name: string; readonly blurb: string }[] = [
  { id: "farmer", name: "青年农夫", blurb: "草帽、背带裤，爱笑的年轻人。" },
  { id: "foreman", name: "包工头", blurb: "安全帽、反光背心，对讲机不离身，一喊就到。" },
  { id: "auntie", name: "农场大婶", blurb: "头巾围裙，小本子上记着每块地的活。" },
  { id: "grandpa", name: "老把式", blurb: "白胡子，种了一辈子地，不慌不忙。" },
  { id: "gardener", name: "园艺师", blurb: "宽檐草帽别朵小花，剪刀揣在围裙兜里。" },
  { id: "robot", name: "机器人管家", blurb: "圆滚滚的农场机器人，脸上的屏会笑。" },
];

/** The young farmer stands in for a look not painted. */
export const orchestratorSprite = (look: string, suffix: string, has: (name: string) => boolean) =>
  has(`manager-${look}${suffix}`) ? `manager-${look}${suffix}` : `manager${suffix}`;

export const lookReady = (look: string, has: (name: string) => boolean) => look === "farmer" || has(`manager-${look}`);

export const petName: Record<string, string> = { dog: "小狗", ragdoll: "重点色布偶猫", bluecat: "蓝猫" };
