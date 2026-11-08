import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Agent, OutfitValues, SpeciesValues } from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { ready, useSprites } from "#/infra/query.ts";
import { Button } from "#/ui/Button.tsx";
import { castOf, castPrefix, cropSprite, outfitLabel, type Pose, randomLook, speciesLabel, stagePoses } from "#/ui/cast.ts";
import { AgentFace } from "#/ui/Face.tsx";
import { PoseSprite } from "#/ui/PoseSprite.tsx";
import { Hint } from "#/ui/Tip.tsx";

const viewStyles = stylex.create({
  labeledDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  labeledDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  labeledSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--wb-muted)",
  },
  labeledSpan2: {
    flex: "1",
  },
  labeledSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-berry)",
  },
  lookPanelDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 5)",
  },
  lookPanelDiv2: {
    display: "grid",
    gridTemplateColumns: "repeat(4,minmax(0,1fr))",
    gap: "calc(var(--spacing) * 1.5)",
  },
  lookPanelSpan: {
    display: "flex",
    height: "calc(var(--spacing) * 16)",
    alignItems: "center",
    justifyContent: "center",
  },
  lookPanelImg: {
    height: "calc(var(--spacing) * 16)",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  stageDiv: {
    position: "relative",
    display: "flex",
    flex: "1",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  stageDiv2: {
    position: "relative",
    height: "calc(var(--spacing) * 72)",
    width: "calc(var(--spacing) * 96)",
    maxWidth: "100%",
  },
  stageImg: {
    position: "absolute",
    bottom: "calc(var(--spacing) * 6)",
    width: "calc(var(--spacing) * 72)",
    imageRendering: "pixelated",
  },
  stageDiv3: {
    position: "absolute",
    right: "calc(var(--spacing) * 24)",
    bottom: "calc(var(--spacing) * 2)",
    translate: "calc(1 / 2 * 100%) 0",
  },
  stageDiv4: {
    pointerEvents: "none",
    position: "absolute",
    insetInline: "0",
    bottom: "calc(var(--spacing) * 4)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--spacing)",
  },
});

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
    <div {...stylex.attrs(viewStyles.labeledDiv)}>
      <div {...stylex.attrs(viewStyles.labeledDiv2)}>
        <span {...stylex.attrs(viewStyles.labeledSpan)}>{props.label}</span>
        <Show when={props.hint ?? props.tip}>{(h) => <Hint text={h()} />}</Show>
        <span {...stylex.attrs(viewStyles.labeledSpan2)} />
        {props.aside}
      </div>
      {props.children}
      <Show when={props.error}>
        <span {...stylex.attrs(viewStyles.labeledSpan3)}>{props.error}</span>
      </Show>
    </div>
  );
}

export function LookPanel(props: { draft: Agent; onChange: (look: Agent["look"]) => void }) {
  const cast = () => castOf(props.draft.look, props.draft.id);
  const sprites = useSprites();
  return (
    <div {...stylex.attrs(viewStyles.lookPanelDiv)}>
      <div>
        <Button icon="shuffle" onClick={() => props.onChange(randomLook())}>
          {t("web.agent.random")}
        </Button>
      </div>
      <Labeled label={t("web.agent.looksAs")} hint={t("web.agent.looksHint")}>
        <div {...stylex.attrs(viewStyles.lookPanelDiv2)}>
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
        <div {...stylex.attrs(viewStyles.lookPanelDiv2)}>
          <For each={OutfitValues}>
            {(outfit) => {
              const name = () => {
                const s = ready(sprites, undefined);
                return s ? `${castPrefix({ ...props.draft.look, species: cast().species, outfit }, props.draft.id, (n) => n in s)}-down` : undefined;
              };
              return (
                <Tile active={cast().outfit === outfit} label={outfitLabel[outfit]} onClick={() => props.onChange({ ...props.draft.look, outfit })}>
                  <span {...stylex.attrs(viewStyles.lookPanelSpan)}>
                    <Show when={name()}>{(n) => <img src={`/pixel/${n()}.png`} alt="" {...stylex.attrs(viewStyles.lookPanelImg)} />}</Show>
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
    <div {...stylex.attrs(viewStyles.stageDiv)} style={{ background: "radial-gradient(60% 60% at 50% 45%, #c7dd9a, #9cc069 60%, #7ea64f)" }}>
      <div {...stylex.attrs(viewStyles.stageDiv2)}>
        <img
          src={`/pixel/${cropSprite(crop())}.png`}
          alt=""
          {...stylex.attrs(viewStyles.stageImg)}
          style={{ left: `${192 - 288 * 0.62}px` }}
          onError={(e) => (e.currentTarget.style.display = "none")}
        />
        <div {...stylex.attrs(viewStyles.stageDiv3)}>
          <PoseSprite cast={cast()} pose={props.pose} height={224} />
        </div>
      </div>
      <div {...stylex.attrs(viewStyles.stageDiv4)}>
        <span class="rounded-md bg-paper/92 px-3 py-0.5 text-lg">{props.draft.name || t("web.agent.unnamedAgent")}</span>
        <Show when={props.draft.duty}>
          <span class="max-w-96 rounded bg-paper/75 px-2 py-px text-center text-xs">{props.draft.duty}</span>
        </Show>
      </div>
      <span class="pointer-events-none absolute top-3 right-4 rounded bg-paper/75 px-2 py-px text-xs">
        {speciesLabel[cast().species]} · {outfitLabel[cast().outfit]}
      </span>
    </div>
  );
}
