// The farm: the village canvas full-bleed, the DOM over it, outside the workbench's shell.
// Each layer is its own package's (README.md); this page only stacks them and owns the keys and the sounds.

import { useEffect } from "react";
import { Link } from "react-router";
import { useFrames } from "../data/frame";
import { VillageCanvas } from "./canvas/VillageCanvas";
import { ChatWindow } from "./chat/ChatWindow";
import { Hud } from "./hud/Hud";
import { IssueView } from "./issue/IssueView";
import { Panels } from "./panels/Panels";
import { usePhoneCalls } from "./phone/calls";
import { useFarmSounds } from "./sound";
import { farm, farmState, useFarm } from "./store";
import { TitleScreen } from "./title/TitleScreen";
import { DebugPanel } from "./debug/DebugPanel";
import { farmKey } from "./tools";

const typing = () => {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
};

function useFarmKeys() {
  useEffect(() => {
    const on = (down: boolean) => (e: KeyboardEvent) => {
      const s = farmState();
      if (s.titleOpen) return;
      const key = farmKey({ key: e.key, down, meta: e.metaKey, control: e.ctrlKey, alt: e.altKey }, typing(), s.overlays.length > 0, s.tool);
      switch (key?.kind) {
        case undefined:
          return;
        case "reveal":
          farm.revealNames(key.down);
          return;
        case "closeTool":
          farm.hold("hand");
          break;
        case "openMenu":
          farm.menu(true);
          break;
        case "pick":
          farm.hold(key.tool);
          break;
      }
      e.preventDefault();
    };
    const down = on(true);
    const up = on(false);
    const blur = () => farm.revealNames(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
}

function FarmSounds() {
  const { frame } = useFrames();
  const tool = useFarm((s) => s.tool);
  const bedFx = useFarm((s) => s.bedFx);
  const overlays = useFarm((s) => s.overlays);
  const chat = useFarm((s) => s.chatOpen);
  const friends = useFarm((s) => s.friendsOpen);
  const has = (kind: string) => overlays.some((o) => o.kind === kind);
  useFarmSounds({
    tool,
    bedFx,
    open: { panel: has("panel"), selected: has("inspect"), sowing: has("sow"), watering: has("water"), friends, chat },
    effects: frame?.effects,
    sessions: frame?.state.sessions,
  });
  return null;
}

export function FarmPage() {
  useFarmKeys();
  usePhoneCalls();
  const { frame, link } = useFrames();
  const titleOpen = useFarm((s) => s.titleOpen);
  useEffect(() => {
    for (const e of frame?.effects ?? []) if (e.kind === "reward") farm.reward(e);
  }, [frame]);
  return (
    <div className="fixed inset-0 overflow-hidden bg-ground font-pixel text-[12px] text-bark-900 select-none" data-testid="farm">
      <FarmSounds />
      <VillageCanvas />
      <Hud />
      <div className="absolute right-3 bottom-3">
        <ChatWindow />
      </div>
      <IssueView />
      <Panels />
      <Link
        to="/issues"
        title="工单、聊天……管活的页面"
        className="absolute top-2 left-2 z-10 border-2 border-bark-900 bg-cream-100 px-2 py-0.5 text-bark-900 shadow-px hover:bg-cream-hover"
      >
        工作台
      </Link>
      {!frame && (
        <p role="status" className="absolute inset-x-0 top-1/3 text-center text-cream-200">
          {link === "lost" ? "连不上农场，重连中……（server 开着吗？）" : "在等农场……"}
        </p>
      )}
      {titleOpen && <TitleScreen />}
      <DebugPanel />
    </div>
  );
}
