import type { Channel, Chat } from "@vibevalley/protocol";
import { channelLabel, channelName } from "@vibevalley/protocol/rules";

export { channelLabel, channelName };

const bySidebar = (a: Channel, b: Channel) => {
  if (a.default !== b.default) return a.default ? -1 : 1;
  const pa = a.position ?? Number.MAX_SAFE_INTEGER;
  const pb = b.position ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export const topsOf = (chat: Chat | undefined): Channel[] =>
  (chat?.channels.filter((c) => c.type === "channel" && c.archived === undefined) ?? []).toSorted(bySidebar);
