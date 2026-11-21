import { effect, lifecycle, untracked } from "nsh";

import { currentLocale } from "@vibevalley/i18n";
import { freshOf } from "@vibevalley/protocol/rules";

import { rawFrame } from "../../infra/frame";
import { currentHost } from "../../infra/host";
import { traySummary } from "./tray";

export function Follow() {
  // The frame as it came: what is news compares one inbox with the one before.
  const frame = rawFrame();
  let known: Set<string> | undefined;
  let tray = "";
  effect(() => {
    const f = frame();
    if (!f) return;
    untracked(() => {
      const host = currentHost();
      const news = freshOf(known, f.inbox);
      known = news.known;
      for (const call of news.fresh)
        if (host.notify && untracked(lifecycle) !== "active")
          void host.notify({ title: call.words.title, body: call.words.body }).catch((e: unknown) => {
            if (!(e instanceof Error)) throw e;
          });
      if (!host.tray) return;
      const summary = traySummary(f.state, f.inbox);
      const said = JSON.stringify(summary);
      if (said === tray) return;
      tray = said;
      void host.tray(summary).catch(() => {
        tray = "";
      });
    });
  });
  untracked(() => currentHost().locale?.(currentLocale()));
  return null;
}
