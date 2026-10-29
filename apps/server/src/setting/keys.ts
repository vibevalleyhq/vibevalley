export const keyHint = (key: string) => "…" + key.slice(-4);

export const agoraID = /^[0-9a-fA-F]{32}$/;

export const voiceURL = /^https?:\/\/\S+$/;

export const hasSpace = (s: string) => /\s/.test(s);
