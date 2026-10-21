// The page following the farm for the host around it: each new call in the inbox as a system notice while the window is
// not in front, the farm at a glance in the tray, and the key that calls the manager from anywhere. Mounted once, over
// every page, the farm's too.

import { createEffect, onSettled } from "solid-js";
import { currentHost } from "@vibevalley/host";
import { CallBell, noticeFor, traySummary } from "../rules/notice";
import { voiceCall } from "../voice/call";
import { rawFrame } from "../farm/state";

export function Follow() {
  // The frame as it came: the bell compares one inbox with the one before.
  const frame = rawFrame();
  const bell = new CallBell();
  let tray = "";
  createEffect(frame, (f) => {
    if (!f) return;
    const host = currentHost();
    for (const call of bell.ring(f.inbox)) if (host.notify && !document.hasFocus()) void host.notify(noticeFor(call)).catch(() => {});
    if (!host.tray) return;
    const summary = traySummary(f.state, f.inbox);
    const said = JSON.stringify(summary);
    if (said === tray) return;
    tray = said;
    void host.tray(summary).catch(() => {});
  });
  onSettled(() => currentHost().voiceShortcut?.on(() => void voiceCall.toggle()));
  return null;
}
