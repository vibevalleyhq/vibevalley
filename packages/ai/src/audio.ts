/** 0..100 RMS loudness level from 16-bit PCM samples. */
export function pcm16RmsLevel(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (const s of pcm) sum += (s / 0x8000) ** 2;
  return Math.min(100, Math.round(Math.sqrt(sum / pcm.length) * 300));
}

/** 0..1 RMS loudness level from normalized Float32 audio samples. */
export function float32RmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

export const dictateRate = 16000;

/** Mono 16-bit PCM in a WAV file. */
function wavOf(samples: Float32Array, sampleRate = dictateRate): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, sampleRate, true);
  out.setUint32(28, sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Uint8Array(out.buffer);
}

const base64Of = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Concatenates recorded Float32Array chunks and encodes them as a base64 WAV string; undefined when no samples were recorded. */
export function encodeWavBase64(chunks: readonly Float32Array[], sampleRate = dictateRate): string | undefined {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total === 0) return undefined;
  const all = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return base64Of(wavOf(all, sampleRate));
}
