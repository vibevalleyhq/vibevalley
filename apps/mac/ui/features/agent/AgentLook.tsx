import { Canvas, colorScheme, Image, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Agent, OutfitValues, SpeciesValues } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { castOf, castPrefix, cropSprite, outfitLabel, type Pose, randomLook, speciesLabel, stagePoses } from "../../design/domain/cast";
import { AgentFace } from "../../design/domain/Face";
import { PoseSprite } from "../../design/domain/PoseSprite";
import { usePixelDir, useSpriteUrl } from "../../design/pixel/atlas";
import { Hint } from "../../design/Tip";
import { mix, tone } from "../../design/tone";
import { ready, useAgentTemplates, useSprites } from "../../infra/query";

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

const avatarOrder = [
  "avatar-orchestrator",
  "avatar-fullstack",
  "avatar-architect",
  "avatar-frontend",
  "avatar-backend",
  "avatar-reviewer",
  "avatar-tester",
  "avatar-designer",
  "avatar-product",
  "avatar-scout",
  "avatar-docs",
  "avatar-pages",
  "avatar-slides",
  "avatar-collector",
] as const;

export function LookPanel(props: { draft: Agent; onChange: (look: Agent["look"]) => void }) {
  const cast = () => castOf(props.draft.look, props.draft.id);
  const sprites = useSprites();
  const templates = useAgentTemplates();
  const url = useSpriteUrl();
  const avatars = () => {
    const all = ready(sprites, undefined);
    if (!all) return [];
    const order = new Map<string, number>(avatarOrder.map((id, i) => [id, i]));
    return Object.keys(all)
      .filter((name) => name.startsWith("avatar-"))
      .toSorted((a, b) => {
        const ia = order.get(a);
        const ib = order.get(b);
        if (ia !== undefined && ib !== undefined) return ia - ib;
        if (ia !== undefined) return -1;
        if (ib !== undefined) return 1;
        return a.localeCompare(b);
      });
  };
  const avatarLabel = (id: string) => {
    const tpl = ready(templates, []).find((item) => item.look.avatar === id);
    return tpl?.name ?? id.replace(/^avatar-/u, "");
  };
  return (
    <View class="gap-5">
      <View class="flex-row">
        <Button icon="shuffle" onPress={() => props.onChange(randomLook())}>
          {t("web.agent.random")}
        </Button>
      </View>
      <If when={avatars().length > 0}>
        <Labeled label={t("web.agent.avatar")} hint={t("web.agent.avatarHint")}>
          <View class="grid grid-cols-4 gap-1.5">
            <Tile
              active={!props.draft.look.avatar}
              label={t("web.agent.avatarAnimal")}
              onClick={() => props.onChange({ ...props.draft.look, avatar: undefined })}
            >
              <AgentFace
                agentId={props.draft.id}
                name={speciesLabel[cast().species]}
                look={{ ...props.draft.look, avatar: undefined, species: cast().species, outfit: cast().outfit }}
                size={40}
              />
            </Tile>
            <Each of={avatars()}>
              {(id) => (
                <Tile active={props.draft.look.avatar === id()} label={avatarLabel(id())} onClick={() => props.onChange({ ...props.draft.look, avatar: id() })}>
                  <AgentFace agentId={props.draft.id} name={avatarLabel(id())} look={{ ...props.draft.look, avatar: id() }} size={40} />
                </Tile>
              )}
            </Each>
          </View>
        </Labeled>
      </If>
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
                  look={{ ...props.draft.look, avatar: undefined, species: species(), outfit: cast().outfit }}
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
                      {(u) => <Image src={u()} class="h-16 w-[41px] object-contain" />}
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
      class={`items-center gap-0.5 rounded-md border px-1 pt-1 pb-1.5 focus-visible:outline-2 focus-visible:outline-focus ${
        props.active ? "border-accent bg-selected" : "border-line hover:border-faint hover:bg-hover"
      }`}
    >
      {props.children}
      <Text class={`max-w-full truncate text-center text-xs font-medium ${props.active ? "text-ink" : "text-muted"}`}>{props.label}</Text>
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
        class="absolute inset-0"
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
          <View class="absolute right-0 bottom-2 w-48 items-center">
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
