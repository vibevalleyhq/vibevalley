export async function publicationKey(job: string, channel: string): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify(["media", job, channel]));
  const hash = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
