import type { MediaAudioFormat } from "@vibevalley/protocol";
const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const mpegRates = [44100, 48000, 32000];

function validWav(bytes: Buffer): boolean {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return false;
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let block = 0;
  let data = false;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return false;
    const kind = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end + (size % 2) > bytes.length) return false;
    if (kind === "fmt ") {
      if (block !== 0 || size < 16 || (size !== 16 && (size < 18 || bytes.readUInt16LE(start + 16) !== size - 18))) return false;
      let format = bytes.readUInt16LE(start);
      const channels = bytes.readUInt16LE(start + 2);
      const rate = bytes.readUInt32LE(start + 4);
      const bits = bytes.readUInt16LE(start + 14);
      if (format === 0xfffe) {
        if (size !== 40 || bytes.readUInt16LE(start + 18) === 0 || bytes.readUInt16LE(start + 18) > bits) return false;
        if (bytes.toString("hex", start + 26, start + 40) !== "000000001000800000aa00389b71") return false;
        format = bytes.readUInt16LE(start + 24);
      }
      if ((format !== 1 && format !== 3) || channels < 1 || channels > 8 || rate < 8000 || rate > 192000) return false;
      if (format === 1 ? ![8, 16, 24, 32].includes(bits) : bits !== 32) return false;
      block = channels * (bits / 8);
      if (bytes.readUInt16LE(start + 12) !== block || bytes.readUInt32LE(start + 8) !== rate * block) return false;
    } else if (kind === "data") {
      if (data || block === 0 || size === 0 || size % block !== 0) return false;
      data = true;
    }
    offset = end + (size % 2);
  }
  return data && offset === bytes.length;
}

export interface AudioByteRange {
  readonly offset: number;
  readonly length: number;
}

export function* mp3Structure(length: number): Generator<AudioByteRange, boolean, Buffer> {
  let offset = 0;
  const bytes = yield { offset: 0, length: 10 };
  if (bytes.toString("latin1", 0, 3) === "ID3") {
    if (bytes.length < 10) return false;
    const version = bytes[3] ?? 0;
    const flags = bytes[5] ?? 0;
    if (version < 2 || version > 4 || bytes[4] === 255 || (flags & (version === 2 ? 0x3f : version === 3 ? 0x1f : 0x0f)) !== 0) return false;
    let size = 0;
    for (let index = 6; index < 10; index++) {
      const part = bytes[index] ?? 0;
      if (part > 127) return false;
      size = size * 128 + part;
    }
    offset = size + 10;
    if (version === 4 && (flags & 0x10) !== 0) {
      const footer = yield { offset, length: 10 };
      if (footer.toString("latin1", 0, 3) !== "3DI" || !bytes.subarray(3, 10).equals(footer.subarray(3, 10))) return false;
      offset += 10;
    }
  }
  const tag = length >= 128 ? yield { offset: length - 128, length: 3 } : undefined;
  const end = tag?.toString("latin1") === "TAG" ? length - 128 : length;
  let frames = 0;
  let stream = -1;
  while (offset < end) {
    if (offset + 4 > end) return false;
    const frame = yield { offset, length: 4 };
    if (frame.length !== 4) return false;
    const header = frame.readUInt32BE(0);
    const version = (header >>> 19) & 3;
    const bitrateIndex = (header >>> 12) & 15;
    const rateIndex = (header >>> 10) & 3;
    const mono = ((header >>> 6) & 3) === 3;
    if (header >>> 21 !== 0x7ff || version === 1 || ((header >>> 17) & 3) !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return false;
    if ((header & 3) === 2) return false;
    const identity = (version << 3) | (rateIndex << 1) | Number(mono);
    if (stream !== -1 && stream !== identity) return false;
    stream = identity;
    const bitrate = (version === 3 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex] ?? 0;
    const rate = (mpegRates[rateIndex] ?? 0) / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const size = Math.floor(((version === 3 ? 144000 : 72000) * bitrate) / rate) + ((header >>> 9) & 1);
    const side = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const checksum = ((header >>> 16) & 1) === 0 ? 2 : 0;
    if (size <= 4 + checksum + side || offset + size > end) return false;
    offset += size;
    frames++;
  }
  return frames >= 2 && offset === end;
}

export function validateSpeechBytes(bytes: Buffer, format: MediaAudioFormat): boolean {
  switch (format) {
    case "wav":
      return validWav(bytes);
    case "mp3": {
      const ranges = mp3Structure(bytes.length);
      let next = ranges.next();
      while (next.done !== true) next = ranges.next(bytes.subarray(next.value.offset, next.value.offset + next.value.length));
      return next.value;
    }
    case "flac":
      return bytes.length > 42 && bytes.toString("ascii", 0, 4) === "fLaC";
    case "aac":
      return bytes.length > 7 && bytes[0] === 255 && ((bytes[1] ?? 0) & 0xf6) === 0xf0;
    case "opus":
      return bytes.length > 36 && bytes.toString("ascii", 0, 4) === "OggS" && bytes.includes(Buffer.from("OpusHead"));
    case "pcm":
      return bytes.length > 0;
  }
}
