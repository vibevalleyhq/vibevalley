// The phone's host, over its WebView's bridge (apps/mobile): the page posts a call as JSON and the shell answers it by
// id; the shell's events (the call's) come back the same way. Both sides import these shapes, so neither guesses.

import type { Host, Notice, RtcEvents, RtcGrant, RtcLine } from "./index";

/** What the page asks of the shell; each is answered once by its id. */
export type ToNative =
  | { readonly id: number; readonly call: "notify"; readonly notice: Notice }
  | { readonly id: number; readonly call: "rtc.join"; readonly grant: RtcGrant }
  | { readonly id: number; readonly call: "rtc.mute"; readonly on: boolean }
  | { readonly id: number; readonly call: "rtc.renew"; readonly token: string }
  | { readonly id: number; readonly call: "rtc.leave" };

/** The shell's answers, and the call's events. */
export type FromNative =
  | { readonly id: number; readonly ok: true }
  | { readonly id: number; readonly ok: false; readonly error: string }
  | { readonly event: "rtc.joined" }
  | { readonly event: "rtc.left" }
  | { readonly event: "rtc.stream"; readonly text: string }
  | { readonly event: "rtc.levels"; readonly mine: number; readonly theirs: number }
  | { readonly event: "rtc.problem"; readonly text: string }
  | { readonly event: "rtc.expiring" };

/** The function on window the shell calls with each FromNative. */
export const fromNativeKey = "vibevalleyFromHost";

type Ask = ToNative extends infer T ? (T extends { id: number } ? Omit<T, "id"> : never) : never;

/** The phone's Host, posting with post; receive takes what the shell sends back. One call at a time, as the page has. */
export function mobileHost(post: (m: ToNative) => void) {
  let next = 1;
  const waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  let events: RtcEvents | undefined;
  const ask = (m: Ask) =>
    new Promise<void>((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      post({ ...m, id } as ToNative);
    });
  const line: RtcLine = {
    mute: (on) => ask({ call: "rtc.mute", on }),
    renew: (token) => ask({ call: "rtc.renew", token }),
    leave: () => ask({ call: "rtc.leave" }).finally(() => (events = undefined)),
  };
  const host: Host = {
    name: "mobile",
    notify: (notice) => ask({ call: "notify", notice: { title: notice.title, body: notice.body } }),
    tray: null,
    voiceShortcut: null,
    titleBar: null,
    rtc: async (grant, on) => {
      events = on;
      try {
        await ask({ call: "rtc.join", grant: { appId: grant.appId, channel: grant.channel, uid: grant.uid, token: grant.token } });
      } catch (e) {
        events = undefined;
        throw e;
      }
      return line;
    },
  };
  const receive = (m: FromNative) => {
    if ("id" in m) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.ok) w?.resolve();
      else w?.reject(new Error(m.error));
      return;
    }
    if (!events) return;
    switch (m.event) {
      case "rtc.joined":
        return events.joined();
      case "rtc.left":
        return events.left();
      case "rtc.stream":
        return events.stream(m.text);
      case "rtc.levels":
        return events.levels(m.mine, m.theirs);
      case "rtc.problem":
        return events.problem(m.text);
      case "rtc.expiring":
        return events.expiring();
    }
  };
  return { host, receive };
}
