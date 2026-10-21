// The farm: the village canvas full-bleed, the DOM over it, outside the workbench's shell. Each layer is its own
// folder's; this page only stacks them and owns the keys, the sounds and the phone's calls.

import { createEffect, Show } from "solid-js";
import type { FarmSoundInput } from "./sound";
import { farm } from "./store";
import { useFrames } from "../data/frame";
import { VillageCanvas } from "./canvas/VillageCanvas";
import { ChatWindow } from "./chat/ChatWindow";
import { DebugPanel } from "./debug/DebugPanel";
import { Hud } from "./hud/Hud";
import { IssueView } from "./issue/IssueView";
import { Panels } from "./panels/Panels";
import { rawFrame, useFarm } from "./state";
import { farmKeys, farmSounds, feedPhoneCalls } from "./support";
import { TitleScreen } from "./title/TitleScreen";

export function FarmPage() {
  const frames = useFrames();
  const raw = rawFrame();
  const titleOpen = useFarm((s) => s.titleOpen);
  farmKeys();
  feedPhoneCalls(raw);
  // A new frame's rewards go on the plots for a few seconds.
  createEffect(raw, (frame) => {
    for (const e of frame?.effects ?? []) if (e.kind === "reward") farm.reward(e);
  });
  return (
    <div class="fixed inset-0 overflow-hidden bg-ground font-pixel text-[12px] text-bark-900 select-none" data-testid="farm">
      <FarmSounds />
      <VillageCanvas />
      <Hud />
      <div class="absolute right-3 bottom-3">
        <ChatWindow />
      </div>
      <IssueView />
      <Panels />
      <Show when={!frames.frame}>
        <p role="status" class="absolute inset-x-0 top-1/3 text-center text-cream-200">
          {frames.link === "lost" ? "连不上农场，重连中……（server 开着吗？）" : "在等农场……"}
        </p>
      </Show>
      <Show when={titleOpen()}>
        <TitleScreen />
      </Show>
      <DebugPanel />
    </div>
  );
}

/** What the sounds hear: the tool, the beds' effects, what is open, and each frame as sent. */
function FarmSounds() {
  const raw = rawFrame();
  const tool = useFarm((s) => s.tool);
  const bedFx = useFarm((s) => s.bedFx);
  const overlays = useFarm((s) => s.overlays);
  const chat = useFarm((s) => s.chatOpen);
  const friends = useFarm((s) => s.friendsOpen);
  const has = (kind: string) => overlays().some((o) => o.kind === kind);
  farmSounds((): FarmSoundInput => ({
    tool: tool(),
    bedFx: bedFx(),
    open: { panel: has("panel"), selected: has("inspect"), sowing: has("sow"), watering: has("water"), friends: friends(), chat: chat() },
    effects: raw()?.effects,
    sessions: raw()?.state.sessions,
  }));
  return null;
}
