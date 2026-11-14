export * from "./shapes.gen";

export const mediaInputContentPath = (id: string) => `/api/v1/media/input/${encodeURIComponent(id)}/content`;
export const mediaSpeechStreamPath = (id: string) => `/api/v1/media/speech/${encodeURIComponent(id)}/stream`;

export const MediaAudioKindValues = ["speakers", "voiceDesign", "clone", "transcription"] as const;
