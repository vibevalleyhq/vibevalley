// What the orchestrator's page says: the looks it can wear and the pets by its door.

import { localized } from "@vibevalley/protocol/words";

const zh = {
  looks: {
    farmer: { name: "青年农夫", blurb: "草帽、背带裤，爱笑的年轻人。" },
    foreman: { name: "包工头", blurb: "安全帽、反光背心，对讲机不离身，一喊就到。" },
    auntie: { name: "农场大婶", blurb: "头巾围裙，小本子上记着每块地的活。" },
    grandpa: { name: "老把式", blurb: "白胡子，种了一辈子地，不慌不忙。" },
    gardener: { name: "园艺师", blurb: "宽檐草帽别朵小花，剪刀揣在围裙兜里。" },
    robot: { name: "机器人管家", blurb: "圆滚滚的农场机器人，脸上的屏会笑。" },
  },
  pet: { dog: "小狗", ragdoll: "重点色布偶猫", bluecat: "蓝猫" },
};

const en: typeof zh = {
  looks: {
    farmer: { name: "Young farmer", blurb: "Straw hat and overalls, always smiling." },
    foreman: { name: "Foreman", blurb: "Hard hat and safety vest, walkie-talkie always on, there at a call." },
    auntie: { name: "Farm auntie", blurb: "Headscarf and apron, every plot's work in her notebook." },
    grandpa: { name: "Old hand", blurb: "White beard, a lifetime of farming, never in a hurry." },
    gardener: { name: "Gardener", blurb: "A flower in a wide straw hat, shears in the apron pocket." },
    robot: { name: "Robot manager", blurb: "A round farm robot whose face screen smiles." },
  },
  pet: { dog: "Puppy", ragdoll: "Colorpoint ragdoll", bluecat: "Blue cat" },
};

export const orchestratorWording = localized({ zh, en });
