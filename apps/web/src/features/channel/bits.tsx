import { For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ChatMessage, Phase } from "@vibevalley/protocol";
import { phaseIcon } from "./rules";
import { AgentFace, OrchestratorFace, OwnerFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import type { IconName } from "../../ui/icons";
import { useAgent } from "../../base/agents";
import { useCore } from "../../base/frame";

export { Dot } from "../../ui/Dot";

export function PhaseGlyph(props: { phase: Phase; size?: number }) {
  return (
    <Show
      when={phaseIcon(props.phase)}
      fallback={<span class="inline-block shrink-0" style={{ width: `${props.size ?? 14}px`, height: `${props.size ?? 14}px` }} />}
    >
      {(icon) => <Icon name={icon()} size={props.size ?? 14} />}
    </Show>
  );
}

/** A helper's face by its profile's look; for a sender without a profile, by its id. */
export function HelperFace(props: { agent: string; runtime?: string; size?: number; muted?: boolean }) {
  const agent = useAgent(() => props.agent);
  const look = () => agent()?.look;
  return <AgentFace agentId={props.agent} look={look()} runtime={props.runtime ?? agent()?.runtime} size={props.size ?? 24} muted={props.muted} />;
}

export function SenderFace(props: { m: ChatMessage; size?: number }) {
  const core = useCore();
  const session = () => core()?.sessions.find((s) => s.id === (props.m.session ?? props.m.from));
  return (
    <Switch>
      <Match when={props.m.fromKind === "owner"}>
        <OwnerFace size={props.size ?? 36} />
      </Match>
      <Match when={props.m.fromKind === "orchestrator"}>
        <OrchestratorFace size={props.size ?? 36} agent={props.m.from} />
      </Match>
      <Match when={props.m.fromKind === "session" || props.m.fromKind === "system"}>
        <HelperFace agent={props.m.agent ?? session()?.agent ?? props.m.from} runtime={session()?.runtime} size={props.size ?? 36} />
      </Match>
    </Switch>
  );
}

export function ThinkingDots() {
  return (
    <span class="inline-flex items-center gap-1" aria-hidden="true">
      <For each={[0, 150, 300]}>
        {(d) => <span class="size-1.5 bg-faint motion-safe:animate-bounce" style={{ "animation-delay": `${d}ms`, "animation-duration": "900ms" }} />}
      </For>
    </span>
  );
}

export function Count(props: { n: number }) {
  return <span class="shrink-0 rounded-full bg-accent px-1.5 text-xs font-semibold text-page tabular-nums">{props.n}</span>;
}

/** What a tag says by its colour: done or new (ok), failed (bad), sent or stopped (wait). Its ink comes with it, so it
 * reads in both themes. */
export type TagTone = "ok" | "bad" | "wait";

const tagTones: Record<TagTone, string> = {
  ok: "bg-ok-soft text-ok-ink",
  bad: "bg-bad-soft text-berry",
  wait: "bg-wheat/25 text-ink",
};

export function Tag(props: { icon?: IconName; label: string; tone: TagTone }) {
  return (
    <span class={["inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-xs font-medium", tagTones[props.tone]]}>
      {props.icon && <Icon name={props.icon} size={12} />}
      {props.label}
    </span>
  );
}

export function Empty(props: { icon: IconName; children: JSX.Element }) {
  return (
    <div data-testid="tab-empty" class="flex h-full items-center justify-center p-6">
      <div class="flex max-w-96 flex-col items-center gap-3 text-center text-sm text-muted">
        <Icon name={props.icon} size={48} class="opacity-80" />
        {props.children}
      </div>
    </div>
  );
}
