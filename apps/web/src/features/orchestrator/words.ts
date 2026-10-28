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
  orchestrator: {
    tab: { memory: "记性", trajectory: "轨迹", archive: "旧账", voice: "声音" },
    all: "← 全部档案",
    title: "管家",
    intro: "管家不当帮工：听你说要做什么，派帮工去做，盯着进度，转告结果。",
    look: (name: string) => `长相是${name}。`,
    profile: "改它的档案",
    tabs: "管家的",
    heard: "收到",
    quiet: "管家还没开过口。",
    trajectory: "管家每一轮的经过",
    about:
      "它收到的话、调的每个工具（点一行看参数和结果）、它说的话。新的在下面，一直留着最近的 1000 步。哪一轮做错了，在它收到的话上点「这一轮做错了」，写一句应该怎样，存成一条评测。",
  },
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
  orchestrator: {
    tab: { memory: "Memory", trajectory: "Trajectory", archive: "Archive", voice: "Voice" },
    all: "← All profiles",
    title: "Manager",
    intro: "The manager is not a helper: it hears what you want done, sends helpers to do it, watches progress and passes on results.",
    look: (name) => `It looks like ${name}.`,
    profile: "Edit its profile",
    tabs: "The manager's",
    heard: "Heard",
    quiet: "The manager has not spoken yet.",
    trajectory: "Each of the manager's rounds",
    about:
      'What it heard, every tool it called (click a row for the arguments and the result), what it said. Newest at the bottom; the last 1000 steps are kept. When a round went wrong, click "This round went wrong" on what it heard, write what it should have done, and it is kept as an eval.',
  },
};

export const orchestratorWording = localized({ zh, en });
