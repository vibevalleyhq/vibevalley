// The settings sections' answers: model providers (VibeValley's providers
// spec account), MOSS Live's check, and the chat apps as the state
// frame carries them (ConnectorsPage.stories' connected WeChat).
import type { ConnectorStatus, ProviderStatus } from "@vibevalley/protocol";

const now = Date.now();
const min = 60_000;
const day = 24 * 60 * min;

const provider: ProviderStatus = {
  revision: 3,
  connections: [
    {
      id: "deepseek",
      name: "DeepSeek",
      adapter: "deepseek",
      enabled: true,
      key: { source: "settings", hint: "…3f9a" },
      models: [
        { id: "deepseek-chat", owner: "deepseek", capabilities: ["chat"] },
        { id: "deepseek-reasoner", owner: "deepseek", capabilities: ["chat"] },
      ],
      verification: { status: "verified", checkedAt: now - min },
    },
    {
      id: "moss-main",
      name: "MOSS",
      adapter: "moss",
      enabled: true,
      key: { source: "settings", hint: "…a41c" },
      models: [
        { id: "moss-image-1", owner: "moss", capabilities: ["image"] },
        { id: "moss-vl", owner: "moss", capabilities: ["vision"] },
        { id: "moss-tts", owner: "moss", capabilities: ["tts"] },
        { id: "moss-speakers", owner: "moss", capabilities: ["tts"] },
        { id: "moss-voice-design", owner: "moss", capabilities: ["tts"] },
        { id: "moss-transcribe", owner: "moss", capabilities: ["asr"] },
        { id: "moss-live", owner: "moss", capabilities: ["realtime"] },
        { id: "moss-live-vision", owner: "moss", capabilities: ["vision"] },
      ],
      verification: { status: "verified", checkedAt: now - min },
    },
  ],
  orchestrator: { connection: "deepseek", model: "deepseek-chat" },
  polish: { connection: "deepseek", model: "deepseek-chat" },
  image: { connection: "moss-main", model: "moss-image-1" },
  understanding: { connection: "moss-main", model: "moss-vl" },
  speech: null,
  speakers: null,
  voiceDesign: null,
  transcription: { connection: "moss-main", model: "moss-transcribe" },
  live: { connection: "moss-main", model: "moss-live" },
  vision: null,
  scenePolicies: [],
};

export const connectors: ConnectorStatus[] = [
  {
    id: "weixin",
    state: "connected",
    qr: "",
    pairCode: "",
    user: "用户",
    channel: "general",
    since: now - 3 * day,
    lastInbound: now - 12 * min,
    pending: 2,
    error: "",
  },
  { id: "feishu", state: "waiting", qr: "https://open.feishu.cn/qr/story-sample", pairCode: "", pending: 0, error: "" },
];

export const responses: Record<string, unknown> = {
  "provider.get": provider,
  "provider.update": provider,
  "provider.verify": provider,
  "voice.moss.verify": { problem: "" },
  "setting.validate": { problem: "" },
  "connector.login": connectors[0],
  "connector.logout": { ...connectors[0], state: "off" },
  "connector.channel.set": connectors[0],
};
