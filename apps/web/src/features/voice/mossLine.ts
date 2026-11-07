import { heard, levelOf, type MossQos, type MossSetup, type MossTurn } from "@vibevalley/ai/realtime/moss-session";
import { Playback } from "@vibevalley/ai/realtime/playback";
import { t } from "@vibevalley/i18n";

import { messageOf } from "#/base/format.ts";

import { MossLine } from "./moss-line.ts";

export { heard, levelOf, MossLine, type MossQos, type MossSetup, type MossTurn, Playback };

/** The playground's one line. */
export const mossLine = new MossLine({
  closed: () => t("web.voice.moss.closed"),
  noMic: () => t("web.voice.call.noMic"),
  formatError: messageOf,
});
