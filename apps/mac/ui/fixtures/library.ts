// The media library's answers and the generation jobs the state frame
// carries (VibeValley's LibraryPage and panel stories): a generated picture,
// an uploaded recording and a fetched page, one job of every kind, and a
// MOSS account with every use bound.
import type { LibraryItem, MediaJob, ProviderVoiceListing } from "@vibevalley/protocol";

const min = 60_000;
const now = Date.now();
const mine = { kind: "user" } as const;
const moss = { model: "moss", connection: "moss-main", revision: 3 } as const;
const stamps = (ago: number) => ({ createdAt: now - ago * min, updatedAt: now - ago * min + 20_000 });

const libraryItems: LibraryItem[] = [
  {
    attachment: { id: "lib-poster", name: "海报.png", type: "image/png", size: 482_113 },
    origin: { kind: "generated", job: "job-image", jobKind: "image" },
    addedAt: now - 30 * min,
    lastAt: now - 30 * min,
  },
  {
    attachment: { id: "lib-standup", name: "周会录音.m4a", type: "audio/mp4", size: 3_204_882 },
    origin: { kind: "uploaded", channel: "general" },
    addedAt: now - 3 * 60 * min,
    lastAt: now - 60 * min,
  },
  {
    attachment: { id: "lib-spec", name: "spec.pdf", type: "application/pdf", size: 88_201 },
    origin: { kind: "fetched", agent: "laozhou", from: { url: "https://example.com/spec.pdf" } },
    addedAt: now - 26 * 60 * min,
    lastAt: now - 26 * 60 * min,
  },
];

const audio = {
  ...moss,
  source: mine,
  problem: "",
  contentType: null,
  input: null,
  resultInput: null,
  previewInput: null,
  result: null,
  canCancel: false,
  canRetryDownload: false,
  canResume: false,
  canCleanup: false,
  canRelease: false,
} as const;

export const mediaJobs: MediaJob[] = [
  {
    kind: "image",
    id: "job-image",
    prompt: "田头的一张海报，像素风",
    ...moss,
    model: "moss-image-1",
    source: mine,
    usage: { images: 1, width: 1024, height: 1024 },
    phase: "ready",
    phaseText: "已生成",
    problem: "",
    attachment: { id: "lib-poster", name: "海报.png", type: "image/png", size: 482_113 },
    canCancel: false,
    canRetryDownload: false,
    ...stamps(30),
  },
  {
    kind: "image",
    id: "job-image-waiting",
    prompt: "一头在田里的牛",
    ...moss,
    model: "moss-image-1",
    source: { kind: "orchestrator", agent: "orchestrator", channel: "general" },
    phase: "generating",
    phaseText: "生成中",
    problem: "",
    canCancel: true,
    canRetryDownload: false,
    ...stamps(1),
  },
  {
    kind: "speech",
    id: "job-speech",
    prompt: "今天的活都干完了。",
    ...moss,
    model: "moss-tts-1.5-flash",
    source: mine,
    voice: "voice-warm",
    format: "wav",
    contentType: "audio/wav",
    metadata: { source: "file", sampleRate: 24_000, duration: 2.4, channels: 1, bitDepth: 16 },
    usage: { inputCharacters: 9 },
    canResume: false,
    canRelease: true,
    phase: "ready",
    phaseText: "已生成",
    problem: "",
    attachment: { id: "lib-speech", name: "speech.wav", type: "audio/wav", size: 115_244 },
    resultInput: null,
    canCancel: false,
    canRetryDownload: false,
    ...stamps(12),
  },
  {
    ...audio,
    kind: "speakers",
    id: "job-dialogue",
    prompt: "host: 早。\nguest: 早，开工吧。",
    model: "moss-speakers",
    phase: "download_failed",
    phaseText: "下载失败",
    problem: "结果没取回来，可以只重试下载。",
    format: "mp3",
    canRetryDownload: true,
    request: {
      id: "job-dialogue",
      connection: "moss-main",
      revision: 3,
      speakers: [
        { id: "host", voice: "voice-warm" },
        { id: "guest", voice: "voice-bright" },
      ],
      segments: [
        { speaker: "host", text: "早。" },
        { speaker: "guest", text: "早，开工吧。" },
      ],
      format: "mp3",
    },
    ...stamps(20),
  },
  {
    ...audio,
    kind: "transcription",
    id: "job-transcript",
    prompt: "周会录音.m4a",
    model: "moss-transcribe-diarize-pro",
    phase: "ready",
    phaseText: "已转写",
    format: null,
    usage: { inputAudioSeconds: 61 },
    input: {
      id: "in-standup",
      kind: "audio",
      name: "周会录音.m4a",
      mime: "audio/mp4",
      size: 3_204_882,
      hash: "1111111111111111111111111111111111111111111111111111111111111111",
    },
    result: {
      kind: "transcription",
      text: "看板能拖了。下周做灵动岛。",
      segments: [
        { speaker: "A", text: "看板能拖了。", start: 0.4, end: 2.1 },
        { speaker: "", text: "下周做灵动岛。", start: 2.6, end: 4.9 },
      ],
    },
    canCleanup: true,
    request: { id: "job-transcript", connection: "moss-main", revision: 3, input: "in-standup", allowUpload: true, diarize: true },
    ...stamps(45),
  },
  {
    kind: "understanding",
    id: "job-understand",
    prompt: "这张海报上写了什么？",
    inputs: [
      {
        id: "in-poster",
        kind: "image",
        name: "海报.png",
        mime: "image/png",
        size: 482_113,
        hash: "2222222222222222222222222222222222222222222222222222222222222222",
      },
    ],
    ...moss,
    model: "moss-vl",
    source: mine,
    authorization: null,
    phase: "ready",
    phaseText: "已理解",
    problem: "",
    result: {
      model: "moss-vl",
      text: "海报上是一片像素风的田，写着「开工」。",
      status: "completed",
      incompleteReason: null,
      usage: { inputTokens: 812, outputTokens: 24, totalTokens: 836 },
    },
    cleanup: "done",
    cleanupText: "远端文件已清理",
    canCancel: false,
    canCleanup: false,
    canRetryDownload: false,
    ...stamps(25),
  },
];

const voices: ProviderVoiceListing = {
  connection: "moss-main",
  revision: 3,
  voices: [
    { id: "voice-warm", name: "暖声", createdAtSeconds: 1_790_000_000 },
    { id: "voice-bright", name: "亮声", createdAtSeconds: 1_790_000_100 },
  ],
  hasMore: false,
  nextCursor: null,
};

export const responses: Record<string, unknown> = {
  "library.item.list": (payload: unknown) => {
    const text = (payload as { text?: string } | null)?.text ?? "";
    return libraryItems.filter((item) => item.attachment.name.includes(text));
  },
  "library.item.add": libraryItems[0],
  "library.item.delete": null,
  "provider.voice.list": voices,
  "media.image.create": mediaJobs[0],
  "media.speech.create": mediaJobs[2],
  "media.dialogue.create": mediaJobs[3],
  "media.job.download": mediaJobs[3],
  "media.job.cancel": mediaJobs[1],
  "media.input.adopt": {
    id: "in-poster",
    kind: "image",
    name: "海报.png",
    mime: "image/png",
    size: 482_113,
    phase: "ready",
    hash: "2222222222222222222222222222222222222222222222222222222222222222",
    createdAt: now,
    expiresAt: now + 60 * min,
    canDelete: true,
  },
  "media.understanding.create": mediaJobs[5],
  "media.transcription.create": mediaJobs[4],
};
