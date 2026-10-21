// The page following the farm for the host around it: each new call in the inbox as a system notice while the window is
// not in front, the farm at a glance in the tray, and the key that calls the manager from anywhere. Mounted once, over
// every page, the farm's too.

import { useEffect, useRef } from "react";
import { currentHost } from "@vibevalley/host";
import { useFrames } from "../data/frame";
import { CallBell, noticeFor, traySummary } from "../rules/notice";
import { voiceCall } from "../voice/call";

export function Follow() {
  const frame = useFrames().frame;
  const bell = useRef(new CallBell());
  const tray = useRef("");
  useEffect(() => {
    if (!frame) return;
    const host = currentHost();
    for (const call of bell.current.ring(frame.inbox)) if (host.notify && !document.hasFocus()) void host.notify(noticeFor(call)).catch(() => {});
    if (!host.tray) return;
    const summary = traySummary(frame.state, frame.inbox);
    const said = JSON.stringify(summary);
    if (said === tray.current) return;
    tray.current = said;
    void host.tray(summary).catch(() => {});
  }, [frame]);
  useEffect(() => currentHost().voiceShortcut?.on(() => void voiceCall.toggle()), []);
  return null;
}
