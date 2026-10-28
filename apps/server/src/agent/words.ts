// What the profiles, the skills and VibeValley's own agent say to the owner: refusals, what a delete would do, the
// templates, and the errors of its own agent that reach the owner.

import { localized } from "@vibevalley/protocol/words";

const zh = {
  template: {
    unreadable: (file: string, why: string) => `模板读不通：${file}（${why}）`,
    noFile: (file: string) => `不是模板：没有 ${file}`,
    badId: (file: string, id: string) => `模板的 id「${id}」不行（${file}）：只能用小写字母、数字和 -，最多 32 个字`,
    badVersion: (file: string) => `模板的 version 要是 1 以上的整数（${file}）`,
    noRuntime: (file: string) => `帮工的模板要写推荐的农机 runtime（${file}）`,
    noTemplate: (id: string) => `没有 ${id} 这个模板`,
    taken: (id: string) => `已经有叫 ${id} 的模板了`,
    builtIn: (id: string) => `${id} 是内置的模板，删不了`,
    notFrom: (name: string) => `「${name}」不是从模板装的`,
    gone: (name: string, template: string) => `「${name}」的模板 ${template} 不在了`,
    delete: (name: string, installed: number) => `删掉模板「${name}」` + (installed > 0 ? `：从它装的 ${installed} 份档案留着` : ""),
  },
  notSaved: (file: string, why: string) => `没存下来：${file} 写不进去（${why}）`,
  orchestratorStays: "默认管家删不了：每个农场至少有一个管家",
  defaultStaysOrchestrator: "默认管家只能是管家：每个农场至少有一个管家",
  noAgent: (id: string) => `没有 ${id} 这个档案`,
  noSkill: (id: string) => `没有 ${id} 这个技能`,
  orchestratorRuntime: (runtime: string) => "管家只在 VibeValley 自己的 agent 上跑：农机要是 " + runtime,
  newAgentId: "新档案的 id 要留空；指定 id 请用保存",
  newSkillId: "新技能的 id 要留空；指定 id 请用保存",
  deleteAgent: (name: string, id: string, runtime: string) => `删掉档案「${name}」（${id}，跑在 ${runtime} 上）：已经派给它的工单不跟着改`,
  deleteSkill: (name: string) => `删掉技能「${name}」`,
  unequip: (holders: readonly string[]) => `从 ${holders.map((h) => `「${h}」`).join("、")} 的档案里摘掉它`,
  /** VibeValley's own agent, when the model's answer is an error without a message. */
  modelFailed: "模型出错了",
  noDeepSeekKey: "没有 DeepSeek 的密钥：设 DEEPSEEK_API_KEY，或者写进 vibevalley.yaml 的 deepseek.api_key。",
  /** The session options VibeValley's own agent refuses, and why. */
  refused: { launchArgs: "VibeValley 跑在 server 进程里，没有命令行参数", serviceTier: "DeepSeek 没有服务档位" },
  efforts: (runtime: string, efforts: readonly string[], asked: string) => `${runtime} 只有 ${efforts.join("、")} 两档思考强度，没有「${asked}」`,
};

const en: typeof zh = {
  template: {
    unreadable: (file, why) => `The template does not read: ${file} (${why})`,
    noFile: (file) => `Not a template: there is no ${file}`,
    badId: (file, id) => `The template id "${id}" will not do (${file}): lowercase letters, digits and - only, up to 32`,
    badVersion: (file) => `A template's version is a whole number from 1 (${file})`,
    noRuntime: (file) => `A helper's template names the machine it is for, runtime (${file})`,
    noTemplate: (id) => `There is no template ${id}`,
    taken: (id) => `There is a template ${id} already`,
    builtIn: (id) => `${id} is built in and cannot be deleted`,
    notFrom: (name) => `"${name}" was not installed from a template`,
    gone: (name, template) => `"${name}"'s template ${template} is gone`,
    delete: (name, installed) => `Delete the template "${name}"` + (installed > 0 ? `: the ${installed} profiles installed from it stay` : ""),
  },
  notSaved: (file, why) => `Not saved: could not write ${file} (${why})`,
  orchestratorStays: "The default manager cannot be deleted: every farm has at least one manager",
  defaultStaysOrchestrator: "The default manager stays a manager: every farm has at least one",
  noAgent: (id) => `There is no profile ${id}`,
  noSkill: (id) => `There is no skill ${id}`,
  orchestratorRuntime: (runtime) => "A manager runs only on VibeValley's own agent: its machine must be " + runtime,
  newAgentId: "Leave a new profile's id empty; to choose the id, save it instead",
  newSkillId: "Leave a new skill's id empty; to choose the id, save it instead",
  deleteAgent: (name, id, runtime) => `Delete the profile "${name}" (${id}, on ${runtime}): tickets already sent to it keep it`,
  deleteSkill: (name) => `Delete the skill "${name}"`,
  unequip: (holders) => `Take it off the profiles of ${holders.map((h) => `"${h}"`).join(", ")}`,
  modelFailed: "the model failed",
  noDeepSeekKey: "No DeepSeek key: set DEEPSEEK_API_KEY, or put it in vibevalley.yaml under deepseek.api_key.",
  refused: { launchArgs: "VibeValley runs inside the server process and takes no command-line arguments", serviceTier: "DeepSeek has no service tiers" },
  efforts: (runtime, efforts, asked) => `${runtime} has only the ${efforts.join(" and ")} thinking efforts, not "${asked}"`,
};

export const agentWording = localized({ zh, en });
