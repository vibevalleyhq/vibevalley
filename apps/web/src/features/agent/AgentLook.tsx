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

const styles = stylex.create({
  stageSpan: {
    borderRadius: "var(--radius-md)",
    backgroundColor: {
      default: "var(--color-avatar-paper)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-paper) 92%, transparent)",
    },
    paddingInline: "0.75rem",
    paddingBlock: "0.125rem",
    fontSize: "var(--text-lg)",
    lineHeight: "var(--leading-lg)",
  },
  stageSpan2: {
    maxWidth: "24rem",
    borderRadius: "var(--radius-sm)",
    backgroundColor: {
      default: "var(--color-avatar-soft-paper)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-paper) 75%, transparent)",
    },
    paddingInline: "0.5rem",
    paddingBlock: "1px",
    textAlign: "center",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  stageSpan3: {
    pointerEvents: "none",
    position: "absolute",
    top: "0.75rem",
    right: "1rem",
    borderRadius: "var(--radius-sm)",
    backgroundColor: {
      default: "var(--color-avatar-soft-paper)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-paper) 75%, transparent)",
    },
    paddingInline: "0.5rem",
    paddingBlock: "1px",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  tileButton: {
    display: "flex",
    cursor: "pointer",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.125rem",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    paddingInline: "0.25rem",
    paddingTop: "0.25rem",
    paddingBottom: "0.375rem",
  },
  tileButtonTone: {
    borderColor: {
      default: "var(--color-ink)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-ink) 40%, transparent)",
    },
    backgroundColor: "var(--color-selected)",
  },
  tileButtonAlt: {
    borderColor: "var(--color-line)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  tileSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  tileSpanTone: {
    fontWeight: "var(--font-weight-semibold)",
  },
  tileSpanAlt: {
    color: "var(--color-muted)",
  },
  labeledDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  labeledDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
  },
  labeledSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-muted)",
  },
  labeledSpan2: {
    flex: "1",
  },
  labeledSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-berry)",
  },
  lookPanelDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
  },
  lookPanelDiv2: {
    display: "grid",
    gridTemplateColumns: "repeat(4,minmax(0,1fr))",
    gap: "0.375rem",
  },
  lookPanelSpan: {
    display: "flex",
    height: "4rem",
    alignItems: "center",
    justifyContent: "center",
  },
  lookPanelImg: {
    height: "4rem",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  stageDiv: {
    backgroundImage: "radial-gradient(60% 60% at 50% 45%, var(--color-agent-stage-center), var(--color-agent-stage-middle) 60%, var(--color-agent-stage-edge))",
    position: "relative",
    display: "flex",
    flex: "1",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  stageDiv2: {
    position: "relative",
    height: "18rem",
    width: "24rem",
    maxWidth: "100%",
  },
  stageImg: {
    left: 192 - 288 * 0.62,
    position: "absolute",
    bottom: "1.5rem",
    width: "18rem",
    imageRendering: "pixelated",
  },
  stageDiv3: {
    position: "absolute",
    right: "6rem",
    bottom: "0.5rem",
    translate: "50% 0",
  },
  stageDiv4: {
    pointerEvents: "none",
    position: "absolute",
    insetInline: "0",
    bottom: "1rem",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.25rem",
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
    <div {...stylex.attrs(styles.labeledDiv)}>
      <div {...stylex.attrs(styles.labeledDiv2)}>
        <span {...stylex.attrs(styles.labeledSpan)}>{props.label}</span>
        <Show when={props.hint ?? props.tip}>{(h) => <Hint text={h()} />}</Show>
        <span {...stylex.attrs(styles.labeledSpan2)} />
        {props.aside}
      </div>
      {props.children}
      <Show when={props.error}>
        <span {...stylex.attrs(styles.labeledSpan3)}>{props.error}</span>
      </Show>
    </div>
  );
}

export function LookPanel(props: { draft: Agent; onChange: (look: Agent["look"]) => void }) {
  const cast = () => castOf(props.draft.look, props.draft.id);
  const sprites = useSprites();
  return (
    <div {...stylex.attrs(styles.lookPanelDiv)}>
      <div>
        <Button icon="shuffle" onClick={() => props.onChange(randomLook())}>
          {t("web.agent.random")}
        </Button>
      </div>
      <Labeled label={t("web.agent.looksAs")} hint={t("web.agent.looksHint")}>
        <div {...stylex.attrs(styles.lookPanelDiv2)}>
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
        <div {...stylex.attrs(styles.lookPanelDiv2)}>
          <For each={OutfitValues}>
            {(outfit) => {
              const name = () => {
                const s = ready(sprites, undefined);
                return s ? `${castPrefix({ ...props.draft.look, species: cast().species, outfit }, props.draft.id, (n) => n in s)}-down` : undefined;
              };
              return (
                <Tile active={cast().outfit === outfit} label={outfitLabel[outfit]} onClick={() => props.onChange({ ...props.draft.look, outfit })}>
                  <span {...stylex.attrs(styles.lookPanelSpan)}>
                    <Show when={name()}>{(n) => <img src={`/pixel/${n()}.png`} alt="" {...stylex.attrs(styles.lookPanelImg)} />}</Show>
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
      {...stylex.attrs(styles.tileButton, props.active ? styles.tileButtonTone : styles.tileButtonAlt)}
    >
      {props.children}
      <span {...stylex.attrs(styles.tileSpan, props.active ? styles.tileSpanTone : styles.tileSpanAlt)}>{props.label}</span>
    </button>
  );
}

/** The helper on the bed its pose goes with, its name under it. */
export function Stage(props: { draft: Agent; pose: Pose }) {
  const cast = () => castOf(props.draft.look, props.draft.id);
  const crop = () => stagePoses.find((p) => p.pose === props.pose)?.crop ?? "empty";
  return (
    <div {...stylex.attrs(styles.stageDiv)}>
      <div {...stylex.attrs(styles.stageDiv2)}>
        <img src={`/pixel/${cropSprite(crop())}.png`} alt="" {...stylex.attrs(styles.stageImg)} onError={(e) => (e.currentTarget.style.display = "none")} />
        <div {...stylex.attrs(styles.stageDiv3)}>
          <PoseSprite cast={cast()} pose={props.pose} height={224} />
        </div>
      </div>
      <div {...stylex.attrs(styles.stageDiv4)}>
        <span {...stylex.attrs(styles.stageSpan)}>{props.draft.name || t("web.agent.unnamedAgent")}</span>
        <Show when={props.draft.duty}>
          <span {...stylex.attrs(styles.stageSpan2)}>{props.draft.duty}</span>
        </Show>
      </div>
      <span {...stylex.attrs(styles.stageSpan3)}>
        {speciesLabel[cast().species]} · {outfitLabel[cast().outfit]}
      </span>
    </div>
  );
}
