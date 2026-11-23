import { effect, lifecycle, untracked } from "nsh";

import { currentLocale } from "@vibevalley/i18n";
import { freshOf } from "@vibevalley/protocol/rules";

import { useCollabSlice, useInboxSlice, useSessionsSlice } from "../../infra/frame";
import { currentHost } from "../../infra/host";
import { traySummary } from "./tray";

export function Follow() {
  const inbox = useInboxSlice();
  const sessions = useSessionsSlice();
  const collab = useCollabSlice();
  let known: Set<string> | undefined;
  let tray = "";

  effect(() => {
    const slice = inbox();
    if (!slice) return;
    untracked(() => {
      const host = currentHost();
      const news = freshOf(known, slice.items);
      known = news.known;
      for (const call of news.fresh)
        if (host.notify && untracked(lifecycle) !== "active")
          void host.notify({ title: call.words.title, body: call.words.body }).catch((e: unknown) => {
            if (!(e instanceof Error)) throw e;
          });
    });
  });

  effect(() => {
    const inboxSlice = inbox();
    const sessionsSlice = sessions();
    const collabSlice = collab();
    if (!inboxSlice) return;
    untracked(() => {
      const host = currentHost();
      if (!host.tray) return;
      const summary = traySummary({ sessions: sessionsSlice, collab: collabSlice, inbox: inboxSlice });
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
