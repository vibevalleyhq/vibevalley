import type { MossQos, MossSetup } from "@vibevalley/ai/realtime/moss-session";
import { t } from "@vibevalley/i18n";

import { messageOf } from "#/base/format.ts";

import { MossLine } from "./moss-line.ts";

export { MossLine, type MossQos, type MossSetup };

/** The playground's one line. */
export const mossLine = new MossLine({
  closed: () => t("web.voice.moss.closed"),
  noMic: () => t("web.voice.call.noMic"),
  formatError: messageOf,
});
