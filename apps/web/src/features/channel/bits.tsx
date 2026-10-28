import { For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ChatMessage, Phase } from "@vibevalley/protocol";
import { phaseIcon } from "./rules";
import { AgentFace, OrchestratorFace, OwnerFace } from "../../ui/Face";
import { Icon, type IconSize } from "../../ui/Icon";
import type { IconName } from "../../ui/icons";
import { useAgent } from "../../base/agents";
import { useCore } from "../../base/frame";

export { Dot } from "../../ui/Dot";

export function PhaseGlyph(props: { phase: Phase; size?: IconSize }) {
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
