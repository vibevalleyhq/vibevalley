import { VibeValleyApi, VibeValleyApiError } from "@vibevalley/protocol";

/** The page is served by the server it talks to: the same origin. */
export const api = new VibeValleyApi("", async (url, init) => {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof TypeError) throw new Error("暂时连不上服务端，请等它恢复后重试。", { cause: error });
    throw error;
  }
});

/** What a refusal says, for a toast or an inline line. */
export const reasonOf = (e: unknown) => (e instanceof VibeValleyApiError ? e.reason : e instanceof Error ? e.message : String(e));

/** A client's key for one send: a retry with the same key is the same message, said once. */
export const newSendKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
