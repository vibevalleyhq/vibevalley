export const keyHint = (key: string) => "…" + key.slice(-4);

export const agoraID = /^[0-9a-fA-F]{32}$/u;

export const voiceURL = /^https?:\/\/\S+$/u;

export const hasSpace = (s: string) => /\s/u.test(s);
