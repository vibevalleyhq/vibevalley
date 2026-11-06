import { t } from "@vibevalley/i18n";
import { heard, levelOf, MossLine, type MossQos, type MossSetup, type MossTurn, Playback } from "@vibevalley/voice/moss";

import { messageOf } from "#/base/format.ts";

export { heard, levelOf, MossLine, type MossQos, type MossSetup, type MossTurn, Playback };

/** The playground's one line. */
export const mossLine = new MossLine({
  closed: () => t("web.voice.moss.closed"),
  noMic: () => t("web.voice.call.noMic"),
  formatError: messageOf,
});
