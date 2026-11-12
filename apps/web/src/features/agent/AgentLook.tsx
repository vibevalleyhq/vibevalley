import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Agent, OutfitValues, SpeciesValues } from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { ready, useSprites } from "#/infra/query.ts";
import { Button } from "#/ui/Button.tsx";
import { castOf, castPrefix, cropSprite, outfitLabel, type Pose, randomLook, speciesLabel, stagePoses } from "#/ui/domain/cast.ts";
import { AgentFace } from "#/ui/domain/Face.tsx";
import { PoseSprite } from "#/ui/domain/PoseSprite.tsx";
import { Hint } from "#/ui/Tip.tsx";

/** A label with what it means behind an info icon, what sits at its right, the control, and what is wrong under it. */
export function Labeled(props: {
  label: string;
  tip?: string;
  hint?: string | undefined;
  error?: string | undefined;
  aside?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center gap-1.5">
        <span class="text-xs font-medium text-muted">{props.label}</span>
        <Show when={props.hint ?? props.tip}>{(h) => <Hint text={h()} />}</Show>
        <span class="flex-1" />
        {props.aside}
      </div>
      {props.children}
      <Show when={props.error}>
        <span class="text-xs text-berry">{props.error}</span>
      </Show>
    </div>
  );
}

export function LookPanel(props: { draft: Agent; onChange: (look: Agent["look"]) => void }) {
  const cast = () => castOf(props.draft.look, props.draft.id);
  const sprites = useSprites();
  return (
    <div class="flex flex-col gap-5">
      <div>
        <Button icon="shuffle" onClick={() => props.onChange(randomLook())}>
          {t("web.agent.random")}
        </Button>
      </div>
      <Labeled label={t("web.agent.looksAs")} hint={t("web.agent.looksHint")}>
        <div class="grid grid-cols-4 gap-1.5">
          <For each={SpeciesValues}>
            {(species) => (
              <Tile active={cast().species === species} label={speciesLabel[species]} onClick={() => props.onChange({ ...props.draft.look, species })}>
                <AgentFace agentId={props.draft.id} runtime={props.draft.runtime} look={{ ...props.draft.look, species, outfit: cast().outfit }} size={48} />
              </Tile>
            )}
          </For>
        </div>
      </Labeled>
      <Labeled label={t("web.agent.wears")}>
        <div class="grid grid-cols-4 gap-1.5">
          <For each={OutfitValues}>
            {(outfit) => {
              const name = () => {
                const s = ready(sprites, undefined);
                return s ? `${castPrefix({ ...props.draft.look, species: cast().species, outfit }, props.draft.id, (n) => n in s)}-down` : undefined;
              };
              return (
                <Tile active={cast().outfit === outfit} label={outfitLabel[outfit]} onClick={() => props.onChange({ ...props.draft.look, outfit })}>
                  <span class="flex h-16 items-center justify-center">
                    <Show when={name()}>{(n) => <img src={`/pixel/${n()}.png`} alt="" class="h-16 object-contain [image-rendering:pixelated]" />}</Show>
                  </span>
                </Tile>
              );
            }}
          </For>
        </div>
      </Labeled>
    </div>
  );
}

function Tile(props: { active: boolean; label: string; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={aria(props.active)}
      onClick={() => props.onClick()}
      class={[
        "flex cursor-pointer flex-col items-center gap-0.5 rounded-md border px-1 pt-1 pb-1.5",
        props.active ? "border-ink/40 bg-selected" : "border-line hover:bg-hover",
      ]}
    >
      {props.children}
      <span class={["text-xs", props.active ? "font-semibold" : "text-muted"]}>{props.label}</span>
    </button>
  );
}

/** The helper on the bed its pose goes with, its name under it. */
export function Stage(props: { draft: Agent; pose: Pose }) {
  const cast = () => castOf(props.draft.look, props.draft.id);
  const crop = () => stagePoses.find((p) => p.pose === props.pose)?.crop ?? "empty";
  return (
    <div class="bg-[image:radial-gradient(60%_60%_at_50%_45%,_var(--color-agent-stage-center),_var(--color-agent-stage-middle)_60%,_var(--color-agent-stage-edge))] relative flex flex-1 items-center justify-center overflow-hidden">
      <div class="relative h-72 w-96 max-w-full">
        <img
          src={`/pixel/${cropSprite(crop())}.png`}
          alt=""
          class="left-[13.439999999999998px] absolute bottom-6 w-72 [image-rendering:pixelated]"
          onError={(e) => (e.currentTarget.style.display = "none")}
        />
        <div class="absolute right-24 bottom-2 translate-x-1/2">
          <PoseSprite cast={cast()} pose={props.pose} height={224} />
        </div>
      </div>
      <div class="pointer-events-none absolute inset-x-0 bottom-4 flex flex-col items-center gap-1">
        <span class="rounded-md bg-paper/92 px-3 py-0.5 text-lg">{props.draft.name || t("web.agent.unnamedAgent")}</span>
        <Show when={props.draft.duty}>
          <span class="max-w-96 rounded-sm bg-paper/75 px-2 py-px text-center text-xs">{props.draft.duty}</span>
        </Show>
      </div>
      <span class="pointer-events-none absolute top-3 right-4 rounded-sm bg-paper/75 px-2 py-px text-xs">
        {speciesLabel[cast().species]} · {outfitLabel[cast().outfit]}
      </span>
    </div>
  );
}
