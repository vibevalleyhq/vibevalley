import { crc32, inflateSync } from "node:zlib";

export function validPng(bytes: Buffer, width: number, height: number): boolean {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  const parts: Buffer[] = [];
  let stride = 0;
  let ended = false;
  for (let at = 8; at < bytes.length;) {
    if (at + 12 > bytes.length) return false;
    const length = bytes.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.toString("ascii", at + 4, at + 8);
    if (crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    if (at === 8) {
      if (type !== "IHDR" || length !== 13 || bytes.readUInt32BE(at + 8) !== width || bytes.readUInt32BE(at + 12) !== height) return false;
      const depth = bytes[at + 16] ?? 0;
      const color = bytes[at + 17] ?? -1;
      const channels = new Map([
        [0, 1],
        [2, 3],
        [3, 1],
        [4, 2],
        [6, 4],
      ]).get(color);
      if (
        channels === undefined ||
        ![1, 2, 4, 8, 16].includes(depth) ||
        ((color === 2 || color === 4 || color === 6) && depth < 8) ||
        (color === 3 && depth > 8)
      )
        return false;
      if (bytes[at + 18] !== 0 || bytes[at + 19] !== 0 || bytes[at + 20] !== 0) return false;
      stride = Math.ceil((width * channels * depth) / 8) + 1;
    } else if (type === "IHDR") return false;
    if (type === "IDAT") parts.push(bytes.subarray(at + 8, end - 4));
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length) return false;
      ended = true;
    }
    at = end;
  }
  if (!ended || parts.length === 0 || stride * height > 32 << 20) return false;
  try {
    const decoded = inflateSync(Buffer.concat(parts), { maxOutputLength: stride * height });
    if (decoded.length !== stride * height) return false;
    for (let row = 0; row < height; row++) if ((decoded[row * stride] ?? 255) > 4) return false;
    return true;
  } catch {
    return false;
  }
}
