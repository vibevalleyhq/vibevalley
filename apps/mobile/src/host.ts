import { type Link, serve } from "@vibevalley/bridge";
import { t } from "@vibevalley/i18n";
import { mobileBridge, type RtcEvents, type RtcLine } from "@vibevalley/protocol/host";

import { notify } from "./notify";
import { nativeRtc } from "./rtc";

/** One loaded page owns this bridge and its native line. Closing it also cancels an unanswered join. */
export function nativeHost(link: Link) {
  const rtc = nativeRtc();
  let closed = false;
  let current: { id: number; line?: RtcLine } | undefined;
  const lineFor = (line: number) => {
    const held = current?.id === line ? current.line : undefined;
    if (!held) throw new Error(t("mobile.callEnded"));
    return held;
  };
  const page = serve(mobileBridge, link, {
    notify: (notice) => notify(notice),
    rtcJoin: async ({ line, grant }) => {
      const call: { id: number; line?: RtcLine } = { id: line };
      current = call;
      const own = () => current === call;
      const events: RtcEvents = {
        joined: () => own() && page.push("rtcJoined", { line }),
        left: () => own() && page.push("rtcLeft", { line }),
        stream: (text) => own() && page.push("rtcStream", { line, text }),
        levels: (mine, theirs) => own() && page.push("rtcLevels", { line, mine, theirs }),
        problem: (text) => own() && page.push("rtcProblem", { line, text }),
        expiring: () => own() && page.push("rtcExpiring", { line }),
      };
      const joined = await rtc.join(grant, events);
      if (closed || !own()) {
        await joined.leave();
        throw new Error(t("mobile.callEnded"));
      }
      call.line = joined;
    },
    rtcMute: ({ line, on }) => lineFor(line).mute(on),
    rtcRenew: ({ line, token }) => lineFor(line).renew(token),
    rtcLeave: ({ line }) => {
      if (current?.id !== line) return;
      current = undefined;
      rtc.close();
    },
  });
  return {
    close: () => {
      closed = true;
      current = undefined;
      page.close();
      rtc.close();
    },
  };
}
