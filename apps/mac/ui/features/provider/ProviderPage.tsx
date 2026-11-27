import {
  type ModelCapability,
  ModelCapabilityValues,
  type ProviderBinding,
  type ProviderConnectionAdapter,
  type ProviderScene,
  type ProviderStatus,
  type ProviderUpdate,
} from "@vibevalley/protocol";

export interface ProviderVendorMeta {
  readonly adapter: ProviderConnectionAdapter;
  readonly id: string;
  readonly name: string;
  readonly defaultBaseUrl: string;
  readonly consoleUrl: string;
  readonly consoleLabel: string;
  readonly keyPlaceholder: string;
  readonly capabilities: readonly ModelCapability[];
}

export const PROVIDER_CATALOG: readonly [ProviderVendorMeta, ...ProviderVendorMeta[]] = [
  {
    adapter: "deepseek",
    id: "deepseek",
    name: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    consoleUrl: "https://platform.deepseek.com/api_keys",
    consoleLabel: "platform.deepseek.com",
    keyPlaceholder: "sk-…",
    capabilities: ["chat"],
  },
  {
    adapter: "minimax",
    id: "minimax",
    name: "MiniMax",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    consoleUrl: "https://platform.minimaxi.com/",
    consoleLabel: "platform.minimaxi.com",
    keyPlaceholder: "eyJ… / sk-…",
    capabilities: ModelCapabilityValues.filter((c) => c !== "realtime" && c !== "image"),
  },
  {
    adapter: "moss",
    id: "moss",
    name: "MOSS",
    defaultBaseUrl: "https://api.mosi.cn/v1",
    consoleUrl: "https://platform.moss.cn/",
    consoleLabel: "platform.moss.cn",
    keyPlaceholder: "sk-…",
    capabilities: ModelCapabilityValues.filter((c) => c !== "chat"),
  },
  {
    adapter: "openai",
    id: "openai",
    name: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    consoleUrl: "https://platform.openai.com/api-keys",
    consoleLabel: "platform.openai.com",
    keyPlaceholder: "sk-…",
    capabilities: [...ModelCapabilityValues],
  },
  {
    adapter: "anthropic",
    id: "anthropic",
    name: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    consoleLabel: "console.anthropic.com",
    keyPlaceholder: "sk-ant-…",
    capabilities: ["chat", "vision"],
  },
];

export const vendorMeta = (adapter: ProviderConnectionAdapter): ProviderVendorMeta =>
  PROVIDER_CATALOG.find((v) => v.adapter === adapter) ?? PROVIDER_CATALOG[0];

export const requiredCapabilityForScene = (scene: ProviderScene): ModelCapability => {
  switch (scene) {
    case "orchestrator":
    case "polish":
      return "chat";
    case "transcription":
      return "asr";
    case "speech":
    case "speakers":
    case "voiceDesign":
      return "tts";
    case "live":
      return "realtime";
    case "vision":
    case "understanding":
      return "vision";
    case "image":
      return "image";
  }
};

export interface DiscoveredModelOption {
  readonly connection: string;
  readonly providerName: string;
  readonly model: string;
  readonly value: string;
}

export const encodeBindingValue = (binding: ProviderBinding | undefined): string => (binding ? `${binding.connection}::${binding.model}` : "");

export const parseBindingValue = (raw: string): ProviderBinding | null => {
  if (!raw) return null;
  const idx = raw.indexOf("::");
  if (idx <= 0) return null;
  return { connection: raw.slice(0, idx), model: raw.slice(idx + 2) };
};

/** Discovered models from enabled, keyed connections matching `capability`. */
export const discoveredModelsForCapability = (status: ProviderStatus, capability: ModelCapability): readonly DiscoveredModelOption[] => {
  const out: DiscoveredModelOption[] = [];
  for (const conn of status.connections) {
    if (!conn.enabled || conn.key.source === null) continue;
    for (const model of conn.models) {
      if (model.capabilities.length > 0 && !model.capabilities.includes(capability)) continue;
      out.push({
        connection: conn.id,
        providerName: conn.name || vendorMeta(conn.adapter).name,
        model: model.id,
        value: `${conn.id}::${model.id}`,
      });
    }
  }
  return out;
};

/** Discovered model IDs on a specific connection matching `capability`. */
export const discoveredModelsForConnection = (status: ProviderStatus, connectionId: string, capability: ModelCapability): readonly string[] => {
  const conn = status.connections.find((c) => c.id === connectionId);
  if (!conn) return [];
  return conn.models.filter((m) => m.capabilities.length === 0 || m.capabilities.includes(capability)).map((m) => m.id);
};

export const totalDiscoveredModelCount = (status: ProviderStatus): number =>
  status.connections.reduce((sum, conn) => (conn.enabled && conn.key.source !== null ? sum + conn.models.length : sum), 0);

export const editableProviderUpdate = (status: ProviderStatus): ProviderUpdate => ({
  revision: status.revision,
  connections: status.connections.map(({ key: _key, models: _models, verification: _verification, baseUrl, ...rest }) => ({
    ...rest,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  })),
  orchestrator: status.orchestrator,
  polish: status.polish,
  image: status.image,
  understanding: status.understanding,
  speech: status.speech,
  live: status.live,
  speakers: status.speakers,
  voiceDesign: status.voiceDesign,
  transcription: status.transcription,
  vision: status.vision,
  scenePolicies: status.scenePolicies,
});
