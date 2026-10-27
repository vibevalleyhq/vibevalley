// One project's farm (/farm/<project>): the village canvas full-bleed, the DOM over it, outside the workbench's shell.
// Each layer is its own folder's; this page only stacks them, gives the ones that draw the beds this project's part of the
// frame (scope.ts), and owns the keys, the sounds and the phone's calls. The chat and the title are the whole farm's.

import { farmWording } from "./words";
import { createEffect, Show } from "solid-js";
import type { FarmSoundInput } from "./sound";
import { farm } from "./store";
import { FramesContext, useFrames } from "../base/frame";
import { VillageCanvas } from "./canvas/VillageCanvas";
import { DebugPanel } from "./debug/DebugPanel";
import { Hud } from "./hud/Hud";
import { IssueView } from "./issue/IssueView";
import { Panels } from "./panels/Panels";
import { createFarmFrames, rawFarmFrame, useFarm } from "./state";
import { farmKeys, farmSounds, feedPhoneCalls } from "./support";
import { TitleScreen } from "./title/TitleScreen";
import { createCall } from "../voice/createCall";

/** `project`: whose farm ("" for the sessions without a project). */
export function FarmPage(props: { project: string }) {
  const frames = useFrames();
  const scoped = createFarmFrames(frames, () => props.project);
  // The farm on the page, and the one `/` opens next time.
  createEffect(
    () => props.project,
    (project) => farm.setProject(project),
  );
  const raw = rawFarmFrame();
  const titleOpen = useFarm((s) => s.titleOpen);
  farmKeys();
  feedPhoneCalls(raw);
  // A call starting (the chat's call button, a ring answered, the desktop's shortcut) brings the phone out unfolded: what
  // is said on it is written into 田头 as it is said. Folded during the call, it stays folded.
  const call = createCall();
  createEffect(
    () => call().phase === "connecting" || call().phase === "live",
    (on) => {
      if (on) farm.chatOpen(true);
    },
  );
  // A new frame's rewards go on the plots for a few seconds.
  createEffect(raw, (frame) => {
    for (const e of frame?.effects ?? []) if (e.kind === "reward") farm.reward(e);
  });
  return (
    <div class="fixed inset-0 overflow-hidden bg-ground font-pixel text-[12px] text-bark-900 select-none" data-testid="farm">
      <FarmSounds />
      <FramesContext value={scoped}>
        <VillageCanvas />
        <Hud />
      </FramesContext>
      <FramesContext value={scoped}>
        <IssueView />
        <Panels />
      </FramesContext>
      <Show when={!frames.frame}>
        <p role="status" class="absolute inset-x-0 top-1/3 text-center text-cream-200">
          {frames.link === "lost" ? farmWording().page.lost : farmWording().page.waiting}
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
  const raw = rawFarmFrame();
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
    issues: raw()?.state.issues,
  }));
  return null;
}
