import { t } from "@vibevalley/i18n";
import type { FromNative, RtcEvents, RtcLine, ToNative } from "@vibevalley/protocol/host";

import { notify } from "./notify";
import { nativeRtc } from "./rtc";

/** One loaded page owns this bridge and its native line. Closing it also cancels an unanswered join. */
export function nativeHost(post: (m: FromNative) => void) {
  const rtc = nativeRtc();
  let closed = false;
  let current: { id: number; line?: RtcLine } | undefined;
  const send = (m: FromNative) => {
    if (!closed) post(m);
  };
  const receive = async (m: ToNative) => {
    if (closed) return;
    try {
      switch (m.call) {
        case "notify":
          await notify(m.notice);
          break;
        case "rtc.join": {
          const call: { id: number; line?: RtcLine } = { id: m.line };
          current = call;
          const emit = (event: FromNative) => {
            if (current === call) send(event);
          };
          const events: RtcEvents = {
            joined: () => emit({ line: m.line, event: "rtc.joined" }),
            left: () => emit({ line: m.line, event: "rtc.left" }),
            stream: (text) => emit({ line: m.line, event: "rtc.stream", text }),
            levels: (mine, theirs) => emit({ line: m.line, event: "rtc.levels", mine, theirs }),
            problem: (text) => emit({ line: m.line, event: "rtc.problem", text }),
            expiring: () => emit({ line: m.line, event: "rtc.expiring" }),
          };
          const line = await rtc.join(m.grant, events);
          if (closed || current !== call) {
            await line.leave();
            throw new Error(t("mobile.callEnded"));
          }
          call.line = line;
          break;
        }
        case "rtc.mute":
        case "rtc.renew": {
          const line = current?.id === m.line ? current.line : undefined;
          if (!line) throw new Error(t("mobile.callEnded"));
          if (m.call === "rtc.mute") await line.mute(m.on);
          else await line.renew(m.token);
          break;
        }
        case "rtc.leave":
          if (current?.id === m.line) {
            current = undefined;
            rtc.close();
          }
          break;
        default:
          return m satisfies never;
      }
      send({ id: m.id, ok: true });
    } catch (e) {
      send({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  return {
    receive,
    close: () => {
      closed = true;
      current = undefined;
      rtc.close();
    },
  };
}
