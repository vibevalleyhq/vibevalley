/** A file's bytes as attachment.create takes them: base64. */
export const attachmentData = (file: Blob): Promise<string> =>
  file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    // In pieces: one call with every byte as an argument overflows the stack for a big file.
    const pieces = Array.from({ length: Math.ceil(bytes.length / 0x8000) }, (_, i) => String.fromCharCode(...bytes.subarray(i * 0x8000, (i + 1) * 0x8000)));
    return btoa(pieces.join(""));
  });

/** Decodes a base64 UTF-8 attachment payload back into a string. */
export function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
