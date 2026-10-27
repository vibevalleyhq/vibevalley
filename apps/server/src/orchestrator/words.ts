// What the orchestrator says to the owner itself (not what its model answers): its name in notices, why it cannot
// think, and why its profile's model is refused.

import { localized } from "@vibevalley/protocol/words";

const zh = {
  /** Who it is in the notices of its host. */
  label: "管家",
  noKey: "我还没有 DeepSeek 的钥匙，想不了事。到首页的「设置」里填上 DeepSeek 的 API Key（工作台左栏最下面的「设置」也能去），填好再跟我说一遍。",
  cannotStart: (why: string) => "我这边起不来：" + why,
  onlyDeepseek: (configured: string) => "管家只接 DeepSeek 的模型：管家档案的模型设成 deepseek/<模型> 或直接写模型名，" + configured + " 用不了",
};

const en: typeof zh = {
  label: "The manager",
  noKey:
    "I don't have a DeepSeek key yet, so I can't think. Put a DeepSeek API Key in Settings (also at the bottom of the workbench's left bar), then tell me again.",
  cannotStart: (why) => "I can't start on my side: " + why,
  onlyDeepseek: (configured) =>
    "The manager runs only on DeepSeek models: set the manager profile's model to deepseek/<model> or just the model's name; " + configured + " cannot be used",
};

export const orchestratorWording = localized({ zh, en });
