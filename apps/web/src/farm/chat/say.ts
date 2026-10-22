import type { Conversation } from "@vibevalley/protocol";
export { newSendKey } from "../../data/api";
import { api } from "../../data/api";

/** Says a line in a conversation (the general one when it is undefined), with the picked helper; the orchestrator is woken first. */
export async function say(text: string, conversation: Conversation | undefined, sendKey: string, agent: string | undefined) {
  await api.orchestrator.open();
  await api.channel.say({ body: { text, conversation: conversation?.kind === "general" ? undefined : conversation?.id, agent, sendKey } });
}
