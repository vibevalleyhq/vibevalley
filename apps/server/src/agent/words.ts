// What the profiles, the skills and VibeValley's own agent say to the owner: refusals, what a delete would do, the
// orchestrator's profile as it is made, and the errors of its own agent that reach the owner.

import { localized } from "@vibevalley/protocol/words";

const zh = {
  orchestrator: { name: "管家", duty: "替主人派活、转告结果" },
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
  orchestrator: { name: "Manager", duty: "Hands out the owner's work and reports back" },
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
