import { Canvas, colorScheme, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Agent, OutfitValues, SpeciesValues } from "@vibevalley/protocol";

import { ROLE_AVATARS } from "../../design/art";
import { Button } from "../../design/Button";
import { assignWorkerAvatars, defaultWorkerAvatar, withDefaultWorkerAvatar } from "../../design/domain/avatar";
import { castOf, outfitLabel, type Pose, randomLook, speciesLabel, stagePoses } from "../../design/domain/cast";
import { AgentFace } from "../../design/domain/Face";
import { Hint } from "../../design/Tip";
import { mix, tone } from "../../design/tone";

export { assignWorkerAvatars, defaultWorkerAvatar, withDefaultWorkerAvatar };

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

function avatarLabel(id: (typeof ROLE_AVATARS)[number]): string {
  switch (id) {
    case "avatar-orchestrator":
      return t("web.agent.avatarLabels.orchestrator");
    case "avatar-fullstack":
      return t("web.agent.avatarLabels.fullstack");
    case "avatar-architect":
      return t("web.agent.avatarLabels.architect");
    case "avatar-frontend":
      return t("web.agent.avatarLabels.frontend");
    case "avatar-backend":
      return t("web.agent.avatarLabels.backend");
    case "avatar-reviewer":
      return t("web.agent.avatarLabels.reviewer");
    case "avatar-tester":
      return t("web.agent.avatarLabels.tester");
    case "avatar-designer":
      return t("web.agent.avatarLabels.designer");
    case "avatar-product":
      return t("web.agent.avatarLabels.product");
    case "avatar-scout":
      return t("web.agent.avatarLabels.scout");
    case "avatar-docs":
      return t("web.agent.avatarLabels.docs");
    case "avatar-pages":
      return t("web.agent.avatarLabels.pages");
    case "avatar-slides":
      return t("web.agent.avatarLabels.slides");
    case "avatar-collector":
      return t("web.agent.avatarLabels.collector");
  }
}

export function LookPanel(props: { draft: Agent; onChange: (look: Agent["look"]) => void }) {
  const cast = () => castOf(props.draft.look, props.draft.id);
  return (
    <View class="gap-5">
      <View class="flex-row">
        <Button icon="shuffle" onPress={() => props.onChange(randomLook())}>
          {t("web.agent.random")}
        </Button>
      </View>
      <Labeled label={t("web.agent.avatar")} hint={t("web.agent.avatarHint")}>
        <View testID="agent-avatar-picker" class="grid grid-cols-3 gap-1.5">
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
          <Each of={ROLE_AVATARS} key={(id) => id}>
            {(id) => (
              <Tile active={props.draft.look.avatar === id()} label={avatarLabel(id())} onClick={() => props.onChange({ ...props.draft.look, avatar: id() })}>
                <AgentFace agentId={props.draft.id} name={avatarLabel(id())} look={{ ...props.draft.look, avatar: id() }} size={40} />
              </Tile>
            )}
          </Each>
        </View>
      </Labeled>
      <Labeled label={t("web.agent.looksAs")} hint={t("web.agent.looksHint")}>
        <View class="grid grid-cols-4 gap-1.5">
          <Each of={SpeciesValues} key={(species) => species}>
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
          <Each of={OutfitValues} key={(outfit) => outfit}>
            {(outfit) => (
              <View
                role="button"
                accessibilityLabel={outfitLabel[outfit()]}
                accessibilityState={{ selected: cast().outfit === outfit() }}
                onPress={() => props.onChange({ ...props.draft.look, outfit: outfit() })}
                class={`items-center justify-center rounded-md border px-2 py-2 focus-visible:outline-2 focus-visible:outline-focus ${
                  cast().outfit === outfit() ? "border-accent bg-selected" : "border-line hover:border-faint hover:bg-hover"
                }`}
              >
                <Text class={`max-w-full truncate text-center text-xs font-medium ${cast().outfit === outfit() ? "text-ink" : "text-muted"}`}>
                  {outfitLabel[outfit()]}
                </Text>
              </View>
            )}
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

/** Papertrails portrait card on the stage, with active pose pill. */
export function Stage(props: { draft: Agent; pose: Pose }) {
  const cast = () => castOf(props.draft.look, props.draft.id);
  const pose = () => stagePoses.find((p) => p.pose === props.pose)?.label ?? "";
  return (
    <View testID="agent-stage" class="min-h-72 flex-1 items-center justify-center overflow-hidden bg-agent-stage-middle">
      <Canvas
        class="absolute inset-0"
        draw={(ctx) => {
          colorScheme();
          const { width, height } = ctx.canvas;
          const g = ctx.createRadialGradient(width / 2, height * 0.45, 0, width / 2, height * 0.45, Math.max(width, height) * 0.6);
          g.addColorStop(0, tone("agent-stage-center"));
          g.addColorStop(0.6, tone("agent-stage-middle"));
          g.addColorStop(1, tone("agent-stage-edge"));
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, width, height);
        }}
      />
      <View testID="agent-stage-art" class="items-center justify-center rounded-xl border border-line bg-avatar-paper p-3 shadow-float">
        <AgentFace
          agentId={props.draft.id}
          name={props.draft.name || t("web.agent.unnamedAgent")}
          runtime={props.draft.runtime}
          look={withDefaultWorkerAvatar(props.draft)}
          size={152}
        />
      </View>
      <View class="absolute top-3 right-4 rounded-sm px-2 py-0.5" style={{ backgroundColor: mix("paper", 0.78) }}>
        <Text class="text-xs font-medium text-bark-900">{`${speciesLabel[cast().species]} · ${outfitLabel[cast().outfit]} · ${pose()}`}</Text>
      </View>
    </View>
  );
}
