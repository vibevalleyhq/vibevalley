import { createEffect, onSettled } from "solid-js";

import { currentLocale } from "@vibevalley/i18n";
import { freshOf } from "@vibevalley/protocol/rules";

import { unreadTotal } from "#/features/channel/index.ts";
import { voiceCall } from "#/features/voice/index.ts";
import { rawFrame } from "#/infra/frame.ts";
import { currentHost } from "#/infra/host.ts";

import { tabTitle, traySummary, waitingOnOwner } from "./tray";

export function Follow() {
  // The frame as it came: what is news compares one inbox with the one before.
  const frame = rawFrame();
  let known: Set<string> | undefined;
  let tray = "";
  createEffect(frame, (f) => {
    if (!f) return;
    document.title = tabTitle(waitingOnOwner(f.inbox), unreadTotal(f.state.chat));
    const host = currentHost();
    const news = freshOf(known, f.inbox);
    known = news.known;
    for (const call of news.fresh)
      if (host.notify && !document.hasFocus()) void host.notify({ title: call.words.title, body: call.words.body }).catch(() => {});
    if (!host.tray) return;
    const summary = traySummary(f.state, f.inbox);
    const said = JSON.stringify(summary);
    if (said === tray) return;
    tray = said;
    void host.tray(summary).catch(() => {});
  });
  onSettled(() => currentHost().locale?.(currentLocale()));
  onSettled(() => currentHost().voiceShortcut?.on(() => void voiceCall.toggle()));
  return null;
}
