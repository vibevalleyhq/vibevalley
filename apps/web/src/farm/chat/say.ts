import type { Conversation } from "@vibevalley/protocol";
import { api } from "../../data/api";

/** 16 random bytes in hex: names one send. */
export const newSendKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Says a line in a conversation (the general one when it is undefined), with the picked helper; the assistant is woken first. */
export async function say(text: string, conversation: Conversation | undefined, sendKey: string, agent: string | undefined) {
  await api.assistant.open();
  await api.channel.say({ body: { text, conversation: conversation?.kind === "general" ? undefined : conversation?.id, agent, sendKey } });
}
