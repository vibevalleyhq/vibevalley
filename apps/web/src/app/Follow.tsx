// The page following the farm for the host around it: each new call in the inbox as a system notice while the window is
// not in front, the farm at a glance in the tray, the key that calls the orchestrator from anywhere, and the language the
// page speaks. Mounted once, over every page, the farm's too.

import { createEffect, onSettled } from "solid-js";
import { currentHost } from "../host";
import { freshOf } from "@vibevalley/protocol/rules";
import { currentLocale } from "@vibevalley/protocol/words";
import { traySummary } from "../rules/notice";
import { voiceCall } from "../features/voice/call";
import { rawFrame } from "../base/frame";

export function Follow() {
  // The frame as it came: what is news compares one inbox with the one before.
  const frame = rawFrame();
  let known: Set<string> | undefined;
  let tray = "";
  createEffect(frame, (f) => {
    if (!f) return;
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
