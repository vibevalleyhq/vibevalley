// The settings sections' answers: model providers (VibeValley's providers
// spec account), the user, devices and sign-in requests, the LAN listener
// with a pairing open, MOSS Live's check, and the chat apps as the state
// frame carries them (ConnectorsPage.stories' connected WeChat).
import type { Approval, ConnectorStatus, LanStatus, ProviderModelListing, ProviderStatus, UserDevice, UserStatus } from "@vibevalley/protocol";

const now = Date.now();
const min = 60_000;
const day = 24 * 60 * min;

export const provider: ProviderStatus = {
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

export const user: UserStatus = { name: "小满", password: true, here: true };

export const devices: UserDevice[] = [
  { id: "d-iphone", name: "iPhone", came: "paired", addedAt: now - 9 * day, lastSeen: now - 40 * min },
  { id: "d-ipad", name: "iPad", came: "login", addedAt: now - 2 * day },
];

export const approvals: Approval[] = [
  { id: "a1", code: "KX7-29Q", name: "MacBook Air", from: "192.168.1.23", askedAt: now - 2 * min, expiresAt: now + 8 * min },
];

export const lan: LanStatus = {
  open: true,
  hostName: "studio.local",
  url: "http://192.168.1.10:7317",
  problem: "",
  pairing: { code: "4821", link: "http://192.168.1.10:7317/pair?code=4821", expiresAt: now + 4 * min },
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
  "user.get": user,
  "user.update": user,
  "user.password.set": user,
  "user.device.list": devices,
  "user.approval.list": approvals,
  "user.approval.answer": [],
  "lan.get": lan,
  "lan.update": lan,
  "lan.pairing.start": lan,
  "lan.pairing.stop": { ...lan, pairing: undefined },
  "voice.moss.verify": { problem: "" },
  "setting.validate": { problem: "" },
  "connector.login": null,
  "connector.logout": null,
  "connector.channel.set": null,
};
