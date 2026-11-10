import { Array as Arr } from "effect";

/** A file's bytes as attachment.create takes them: base64. */
export const attachmentData = (file: Blob): Promise<string> =>
  file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    // In pieces: one call with every byte as an argument overflows the stack for a big file.
    const pieces = Arr.makeBy(Math.ceil(bytes.length / 0x8000), (i) => String.fromCharCode(...bytes.subarray(i * 0x8000, (i + 1) * 0x8000)));
    return btoa(pieces.join(""));
  });
