// Ported from VibeValley apps/web/src/features/agent/AgentLook.tsx: the
// labeled field, the look panel and the stage: the outfits' sprites and
// the posed helper on its bed, from the app's art (ui/pixel/atlas.ts); the
// stage's radial ground is drawn on a Canvas. While the art is not
// installed, an outfit is its name and the stage shows the helper's face.
import { Canvas, colorScheme, Image, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Agent, OutfitValues, SpeciesValues } from "@vibevalley/protocol";

import { ready, useSprites } from "../../infra/query";
import { Button } from "../../ui/Button";
import { castOf, castPrefix, cropSprite, outfitLabel, type Pose, randomLook, speciesLabel, stagePoses } from "../../ui/domain/cast";
import { AgentFace } from "../../ui/domain/Face";
import { PoseSprite } from "../../ui/domain/PoseSprite";
import { usePixelDir, useSpriteUrl } from "../../ui/pixel/atlas";
import { Hint } from "../../ui/Tip";
import { tone } from "../../ui/tone";
import { mix } from "../../ui/tone";

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
    <View class="gap-1">
      <View class="flex-row items-center gap-1.5">
        <Text class="text-xs font-medium text-muted">{props.label}</Text>
        <If when={props.hint ?? props.tip}>{(h) => <Hint text={h()} />}</If>
        <View class="flex-1" />
        {props.aside}
      </View>
      {props.children}
      <If when={props.error}>
        <Text class="text-xs text-berry">{props.error}</Text>
      </If>
    </View>
  );
}

export function LookPanel(props: { draft: Agent; onChange: (look: Agent["look"]) => void }) {
  const cast = () => castOf(props.draft.look, props.draft.id);
  const sprites = useSprites();
  const url = useSpriteUrl();
  return (
    <View class="gap-5">
      <View class="flex-row">
        <Button icon="shuffle" onPress={() => props.onChange(randomLook())}>
          {t("web.agent.random")}
        </Button>
      </View>
      <Labeled label={t("web.agent.looksAs")} hint={t("web.agent.looksHint")}>
        <View class="grid grid-cols-4 gap-1.5">
          <Each of={SpeciesValues}>
            {(species) => (
              <Tile
                active={cast().species === species()}
                label={speciesLabel[species()]}
                onClick={() => props.onChange({ ...props.draft.look, species: species() })}
              >
                <AgentFace
                  agentId={props.draft.id}
                  name={speciesLabel[species()]}
                  runtime={props.draft.runtime}
                  look={{ ...props.draft.look, species: species(), outfit: cast().outfit }}
                  size={48}
                />
              </Tile>
            )}
          </Each>
        </View>
      </Labeled>
      <Labeled label={t("web.agent.wears")}>
        <View class="grid grid-cols-4 gap-1.5">
          <Each of={OutfitValues}>
            {(outfit) => {
              const src = () => {
                const all = ready(sprites, undefined);
                return all
                  ? url(`${castPrefix({ ...props.draft.look, species: cast().species, outfit: outfit() }, props.draft.id, (n) => n in all)}-down`)
                  : undefined;
              };
              return (
                <Tile
                  active={cast().outfit === outfit()}
                  label={outfitLabel[outfit()]}
                  onClick={() => props.onChange({ ...props.draft.look, outfit: outfit() })}
                >
                  <View class="h-16 items-center justify-center">
                    <If when={src()} else={<View class="h-8" />}>
                      {(u) => <Image src={u()} style={{ height: 64, width: 41, objectFit: "contain" }} />}
                    </If>
                  </View>
                </Tile>
              );
            }}
          </Each>
        </View>
      </Labeled>
    </View>
  );
}

function Tile(props: { active: boolean; label: string; onClick: () => void; children: JSX.Element }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.active }}
      onPress={() => props.onClick()}
      class={`items-center gap-0.5 rounded-md border px-1 pt-1 pb-1.5 transition duration-120 ease-out ${props.active ? "bg-selected" : "border-line hover:bg-hover"}`}
      style={props.active ? { borderColor: mix("ink", 0.4) } : undefined}
    >
      {props.children}
      <Text class={`text-xs ${props.active ? "font-semibold text-ink" : "text-muted"}`}>{props.label}</Text>
    </View>
  );
}

/** The helper on the bed its pose goes with, its name under it. */
export function Stage(props: { draft: Agent; pose: Pose }) {
  const cast = () => castOf(props.draft.look, props.draft.id);
  const pose = () => stagePoses.find((p) => p.pose === props.pose)?.label ?? "";
  const dir = usePixelDir();
  const url = useSpriteUrl();
  const sprites = useSprites();
  const bed = () => {
    const name = cropSprite(stagePoses.find((p) => p.pose === props.pose)?.crop ?? "empty");
    const size = ready(sprites, undefined)?.[name];
    const src = url(name);
    return src && size ? { src, height: (288 * size.h) / size.w } : undefined;
  };
  return (
    <View class="min-h-72 flex-1 items-center justify-center overflow-hidden bg-agent-stage-middle">
      <Canvas
        style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
        draw={(ctx) => {
          colorScheme();
          const { width, height } = ctx.canvas;
          // CSS's radial-gradient(60% 60% at 50% 45%, center, middle 60%, edge), as a circle on the larger side.
          const g = ctx.createRadialGradient(width / 2, height * 0.45, 0, width / 2, height * 0.45, Math.max(width, height) * 0.6);
          g.addColorStop(0, tone("agent-stage-center"));
          g.addColorStop(0.6, tone("agent-stage-middle"));
          g.addColorStop(1, tone("agent-stage-edge"));
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, width, height);
        }}
      />
      <If
        when={dir()}
        else={
          <View class="items-center justify-center rounded-full bg-agent-stage-center p-10">
            <AgentFace
              agentId={props.draft.id}
              name={props.draft.name || t("web.agent.unnamedAgent")}
              runtime={props.draft.runtime}
              look={props.draft.look}
              size={140}
            />
          </View>
        }
      >
        <View testID="agent-stage-art" class="h-72 w-96 max-w-full">
          <If when={bed()}>{(b) => <Image src={b().src} style={{ position: "absolute", left: 13, bottom: 24, width: 288, height: b().height }} />}</If>
          <View class="items-center" style={{ position: "absolute", right: 0, bottom: 8, width: 192 }}>
            <PoseSprite cast={cast()} pose={props.pose} height={224} />
          </View>
        </View>
      </If>
      <View class="absolute inset-x-0 bottom-4 items-center gap-1">
        <View class="rounded-md px-3 py-0.5" style={{ backgroundColor: mix("paper", 0.92) }}>
          <Text class="text-lg font-semibold text-bark-900">{props.draft.name || t("web.agent.unnamedAgent")}</Text>
        </View>
        <If when={props.draft.duty}>
          <View class="max-w-96 rounded-sm px-2 py-0.5" style={{ backgroundColor: mix("paper", 0.78) }}>
            <Text class="text-center text-xs text-bark-900">{props.draft.duty}</Text>
          </View>
        </If>
      </View>
      <View class="absolute top-3 right-4 rounded-sm px-2 py-0.5" style={{ backgroundColor: mix("paper", 0.78) }}>
        <Text class="text-xs font-medium text-bark-900">{`${speciesLabel[cast().species]} · ${outfitLabel[cast().outfit]} · ${pose()}`}</Text>
      </View>
    </View>
  );
}
