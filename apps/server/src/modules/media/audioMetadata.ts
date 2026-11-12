import { parseBlob } from "music-metadata";

class MediaAudioInvalid extends Error {
  override readonly name = "MediaAudioInvalid";
  constructor(fields: { readonly cause?: unknown } = {}) {
    super("The audio could not be read", "cause" in fields ? { cause: fields.cause } : undefined);
  }
}

export interface AudioMetadata {
  format: "wav" | "mp3" | "m4a" | "flac" | "aac" | "opus" | "ogg" | "webm";
  duration: number;
  sampleRate: number;
  channels: number;
  bitDepth?: number;
}

/** Throws MediaAudioInvalid for whatever stops it being read. */
const readOr = async <A>(read: () => Promise<A>): Promise<A> => {
  try {
    return await read();
  } catch (cause) {
    throw new MediaAudioInvalid({ cause });
  }
};

const waveBytes = async (blob: Blob, start: number, end: number) => Buffer.from(await readOr(() => blob.slice(start, end).arrayBuffer()));

export async function inspectWave(blob: Blob): Promise<AudioMetadata> {
  const header = await waveBytes(blob, 0, 12);
  if (
    header.length !== 12 ||
    header.toString("ascii", 0, 4) !== "RIFF" ||
    header.toString("ascii", 8, 12) !== "WAVE" ||
    header.readUInt32LE(4) + 8 !== blob.size
  )
    throw new MediaAudioInvalid();
  let offset = 12;
  let block = 0;
  let data = false;
  let sampleRate = 0;
  let channels = 0;
  let bitDepth = 0;
  let dataSize = 0;
  while (offset < blob.size) {
    const chunk = await waveBytes(blob, offset, offset + 8);
    if (chunk.length !== 8) throw new MediaAudioInvalid();
    const size = chunk.readUInt32LE(4);
    const start = offset + 8;
    const end = start + size + (size % 2);
    if (end > blob.size) throw new MediaAudioInvalid();
    const kind = chunk.toString("ascii", 0, 4);
    if (kind === "fmt ") {
      if (block !== 0 || size < 16 || size > 40) throw new MediaAudioInvalid();
      const fmt = await waveBytes(blob, start, start + size);
      if (size !== 16 && (size < 18 || fmt.readUInt16LE(16) !== size - 18)) throw new MediaAudioInvalid();
      let encoding = fmt.readUInt16LE(0);
      channels = fmt.readUInt16LE(2);
      const rate = fmt.readUInt32LE(4);
      const bits = fmt.readUInt16LE(14);
      if (encoding === 0xfffe) {
        if (size !== 40 || fmt.readUInt16LE(18) === 0 || fmt.readUInt16LE(18) > bits || fmt.toString("hex", 26, 40) !== "000000001000800000aa00389b71")
          throw new MediaAudioInvalid();
        encoding = fmt.readUInt16LE(24);
      }
      if (
        (encoding !== 1 && encoding !== 3) ||
        channels < 1 ||
        channels > 8 ||
        rate < 8000 ||
        rate > 192000 ||
        (encoding === 1 ? bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32 : bits !== 32)
      )
        throw new MediaAudioInvalid();
      block = (channels * bits) / 8;
      if (fmt.readUInt16LE(12) !== block || fmt.readUInt32LE(8) !== rate * block) throw new MediaAudioInvalid();
      sampleRate = rate;
      bitDepth = bits;
    } else if (kind === "data") {
      if (data || block === 0 || size === 0 || size % block !== 0) throw new MediaAudioInvalid();
      data = true;
      dataSize = size;
    }
    offset = end;
  }
  if (!data) throw new MediaAudioInvalid();
  return { format: "wav" as const, duration: dataSize / block / sampleRate, sampleRate, channels, bitDepth };
}

/** What an audio file is, read from its bytes; throws MediaAudioInvalid for anything that is not plainly audio. */
export async function inspectAudio(blob: Blob): Promise<AudioMetadata> {
  const prefix = Buffer.from(await readOr(() => blob.slice(0, 16).arrayBuffer()));
  const parsed = await readOr(() =>
    parseBlob(blob.slice(0, blob.size, ""), { duration: true, skipCovers: true, maxMemoryAllocation: 1024 * 1024, maxMetadataEntries: 1000 }),
  );
  const { duration, sampleRate, numberOfChannels, codec, bitsPerSample } = parsed.format;
  if (
    duration === undefined ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    sampleRate === undefined ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 384000 ||
    numberOfChannels === undefined ||
    !Number.isInteger(numberOfChannels) ||
    numberOfChannels < 1 ||
    numberOfChannels > 32
  )
    throw new MediaAudioInvalid();
  if (!codec || /unknown|non-PCM/iu.test(codec) || parsed.format.hasVideo === true || parsed.format.hasAudio === false) throw new MediaAudioInvalid();
  if (parsed.quality.warnings.length > 0) {
    // RIFF permits ancillary chunks; metadata warnings need structural validation rather than blanket rejection.
    if (prefix.toString("ascii", 0, 4) === "RIFF" && prefix.toString("ascii", 8, 12) === "WAVE") return inspectWave(blob);
    throw new MediaAudioInvalid();
  }
  if (bitsPerSample !== undefined && (!Number.isInteger(bitsPerSample) || bitsPerSample < 1 || bitsPerSample > 64)) throw new MediaAudioInvalid();
  const signature = prefix.toString("latin1");
  let format: AudioMetadata["format"];
  if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WAVE") format = "wav";
  else if (signature.startsWith("fLaC")) format = "flac";
  else if (signature.slice(4, 8) === "ftyp") format = "m4a";
  else if (signature.startsWith("OggS")) format = codec.toLowerCase().includes("opus") ? "opus" : "ogg";
  else if (prefix.toString("hex").startsWith("1a45dfa3")) format = "webm";
  else if (codec.includes("AAC")) format = "aac";
  else if (codec.includes("Layer 3")) format = "mp3";
  else throw new MediaAudioInvalid();
  return { format, duration, sampleRate, channels: numberOfChannels, ...(bitsPerSample === undefined ? {} : { bitDepth: bitsPerSample }) };
}
