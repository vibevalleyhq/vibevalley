import { t } from "@vibevalley/i18n";
// The farm chat window's words: a channel's name as the farm says it, a message's clock time, and whether it is long
// enough to fold.

import type { Channel } from "@vibevalley/protocol";
import { channelLabel } from "@/features/channel";

/** The farm calls the default channel by its words' chat.label (田头). */
export const farmChannelLabel = (c: Channel | undefined) => (!c || c.default ? t("web.farm.chat.label") : channelLabel(c));

export const farmClock = (at: number) => {
  const d = new Date(Math.round(at));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Long enough to fold: over 240 characters, eight lines or more, a heading or a code block. */
export const readsLong = (text: string) => text.length > 240 || (text.match(/\n/g)?.length ?? 0) >= 8 || /^(#{1,6} |```)/m.test(text);
