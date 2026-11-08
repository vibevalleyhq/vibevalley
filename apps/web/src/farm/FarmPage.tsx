import * as stylex from "@stylexjs/stylex";
import { createEffect, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { createCall } from "#/features/voice/index.ts";
import { FramesContext, useFrames } from "#/infra/frame.ts";

import { VillageCanvas } from "./canvas/VillageCanvas";
import { type FarmSoundInput, farmSounds } from "./cues";
import { DebugPanel } from "./debug/DebugPanel";
import { createFarmFrames, rawFarmFrame } from "./frames";
import { Hud } from "./hud/Hud";
import { IssueView } from "./issue/IssueView";
import { Panels } from "./panels/Panels";
import { feedPhoneCalls } from "./phone/calls";
import { farm, useFarm } from "./store";
import { farmKeys } from "./tools";

const recipeStyles = stylex.create({
  farmPageDiv: {
    position: "relative",
    isolation: "isolate",
    height: "100%",
    overflow: "hidden",
    backgroundColor: "var(--color-ground)",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    color: "var(--color-bark-900)",
    WebkitUserSelect: "none",
    userSelect: "none",
  },
});

const viewStyles = stylex.create({
  farmPageP: {
    position: "absolute",
    insetInline: "0",
    top: "33.3333%",
    textAlign: "center",
    color: "var(--color-cream-200)",
  },
});

/** `repo`: whose farm ("" for the sessions without a repo). */
export function FarmPage(props: { repo: string }) {
  const frames = useFrames();
  const scoped = createFarmFrames(frames, () => props.repo);
  // The farm on the page, and the one `/` opens next time.
  createEffect(
    () => props.repo,
    (repo) => farm.setRepo(repo),
  );
  const raw = rawFarmFrame();
  farmKeys();
  feedPhoneCalls(raw);
  // A call starting (the chat's call button, a ring answered, the desktop's shortcut) brings the phone out unfolded. Folded during the call, it stays folded.
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
  // Drawn: the workbench's dark theme does not reach in (style.css).
  return (
    <div data-theme="light" {...stylex.attrs(recipeStyles.farmPageDiv)} data-testid="farm">
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
        <p role="status" {...stylex.attrs(viewStyles.farmPageP)}>
          {frames.link === "lost" ? t("web.farm.page.lost") : t("web.farm.page.waiting")}
        </p>
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
  farmSounds((): FarmSoundInput =>
    omitUndefined({
      tool: tool(),
      bedFx: bedFx(),
      open: { panel: has("panel"), selected: has("inspect"), sowing: has("sow"), watering: has("water"), friends: friends(), chat: chat() },
      effects: raw()?.effects,
      sessions: raw()?.state.sessions,
      issues: raw()?.state.issues,
    }),
  );
  return null;
}
