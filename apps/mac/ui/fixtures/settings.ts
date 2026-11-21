// The settings sections' answers: model providers (VibeValley's providers
// spec account), MOSS Live's check, and the chat apps as the state
// frame carries them (ConnectorsPage.stories' connected WeChat).
import type { ConnectorStatus, ProviderModelListing, ProviderStatus } from "@vibevalley/protocol";

const now = Date.now();
const min = 60_000;
const day = 24 * 60 * min;

const provider: ProviderStatus = {
  revision: 3,
  connections: [{ id: "moss-main", name: "MOSS", adapter: "moss", enabled: true, key: { source: "settings", hint: "…a41c" } }],
  image: { connection: "moss-main", model: "moss-image-1" },
  imageModels: ["moss-image-1", "moss-image-1-hd"],
  understanding: { connection: "moss-main", model: "moss-vl" },
  understandingModels: ["moss-vl"],
  dictation: { connection: "moss-main", model: "moss-asr" },
  dictationModels: ["moss-asr", "moss-asr-fast"],
  speech: null,
  speechModels: ["moss-tts"],
  speakers: null,
  speakersModels: ["moss-speakers"],
  voiceDesign: null,
  voiceDesignModels: ["moss-voice-design"],
  transcription: { connection: "moss-main", model: "moss-transcribe" },
  transcriptionModels: ["moss-transcribe"],
  live: { connection: "moss-main", model: "moss-live" },
  liveModels: ["moss-live"],
  vision: null,
  visionModels: ["moss-live-vision"],
};

const models: ProviderModelListing = {
  connection: "moss-main",
  revision: 3,
  models: [
    { id: "moss-image-1", owner: "moss" },
    { id: "moss-vl", owner: "moss" },
    { id: "moss-live", owner: "moss" },
  ],
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
  "provider.model.list": models,
  "voice.moss.verify": { problem: "" },
  "setting.validate": { problem: "" },
  "connector.login": connectors[0],
  "connector.logout": { ...connectors[0], state: "off" },
  "connector.channel.set": connectors[0],
};
