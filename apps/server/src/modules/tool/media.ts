import { t } from "@vibevalley/i18n";

import { jsonText } from "#/base/json.ts";
import type { MediaCaller } from "#/modules/media/media.ts";

import { callerOf, refuse, tool, type Who } from "./schemas.ts";
import type { ToolDeps } from "./tool.ts";

export function mediaTools(deps: Pick<ToolDeps, "media">) {
  const { media } = deps;
  // Making media is the user's: only the orchestrator answering for them may, as the orchestrator.
  const makerOf = (who: Who): MediaCaller => {
    const caller = callerOf(who);
    if (caller.actor.kind !== "agent" || caller.actor.role !== "orchestrator") throw refuse(t("server.media.userRequired"));
    return { kind: "orchestrator", agent: caller.agent, channel: caller.here, forUser: caller.actor.forUser === true };
  };
  return (who: Who) => [
    tool("media.image.create", async (input) => jsonText(await media.createImage(input, makerOf(who)))),
    tool("media.understanding.start", async ({ id }) => jsonText(await media.startUnderstanding(id, makerOf(who)))),
    tool("media.speech.create", async (input) => jsonText(await media.createSpeech(input, makerOf(who)))),
    tool("media.dialogue.create", async (input) => jsonText(await media.createSpeakers(input, makerOf(who)))),
    tool("media.voiceDesign.create", async (input) => jsonText(await media.createVoiceDesign(input, makerOf(who)))),
    tool("media.job.get", async ({ id }) => jsonText(await media.get(id))),
    tool("media.job.cancel", async ({ id }) => jsonText(await media.cancel(id))),
    tool("media.job.download", async ({ id }) => jsonText(await media.retryDownload(id))),
    tool("media.job.list", async () => jsonText(await media.list())),
  ];
}
