import type { JSX } from "@solidjs/web";
import { For, Match, Show, Switch } from "solid-js";

import { type ChatMessage, type Phase, type SessionView } from "@vibevalley/protocol";
import { actorRoleOf, spanText } from "@vibevalley/protocol/rules";

import { useAgent } from "#/infra/agents.ts";
import { useCore } from "#/infra/frame.ts";
import { AgentFace, OrchestratorFace, UserFace } from "#/ui/domain/Face.tsx";
import { Icon, type IconSize } from "#/ui/Icon.tsx";
import { actionIcon, type IconName } from "#/ui/icons.ts";

const viewStyles = {
  glyphSize: (size: number): JSX.CSSProperties => ({ width: `${size}px`, height: `${size}px` }),
  thinkingTiming: (delay: number): JSX.CSSProperties => ({ "animation-delay": `${delay}ms` }),
};
const span = spanText;

export { Dot } from "#/ui/Tag.tsx";

/** The server's words for what the session is doing, how long it has been quiet filled in by the clock. */
export function phaseText(h: SessionView, now: number) {
  const words = h.phaseText;
  return h.phase._tag === "working" && h.phase.quietSince !== undefined ? words.replaceAll("{span}", span(now - h.phase.quietSince)) : words;
}

export type DotTone = "leaf" | "berry" | "wheat";

export function phaseDot(p: Phase): DotTone {
  switch (p._tag) {
    case "working":
      return "leaf";
    case "failed":
      return "berry";
    case "done":
    case "resting":
    case "closed":
      return "wheat";
  }
}

/** The sprite for a phase; undefined draws nothing. */
function phaseIcon(p: Phase): IconName | undefined {
  switch (p._tag) {
    case "working":
      return p.doing.action === "none" ? undefined : actionIcon[p.doing.action];
    case "done":
      return "check";
    case "failed":
      return "cross";
    case "resting":
      return "wait";
    case "closed":
      return p.closed === "merged" ? "check" : "wait";
  }
}

export const runtimeLabel: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** A profile's duty up to its first stop, at most 18 characters. */
export function dutyShort(duty: string) {
  const first = duty.split(/[，。,.]/u)[0] ?? "";
  return first.length > 18 ? first.slice(0, 18) : first;
}

export function PhaseGlyph(props: { phase: Phase; size?: IconSize }) {
  return (
    <Show when={phaseIcon(props.phase)} fallback={<span class="inline-block shrink-0" style={viewStyles.glyphSize(props.size ?? 14)} />}>
      {(icon) => <Icon name={icon()} size={props.size ?? 14} />}
    </Show>
  );
}

/** A helper's face by its profile's look; for a sender without a profile, by its id. */
export function HelperFace(props: { agent: string; runtime?: string | undefined; size?: number; muted?: boolean }) {
  const agent = useAgent(() => props.agent);
  const look = () => agent()?.look;
  return <AgentFace agentId={props.agent} look={look()} runtime={props.runtime ?? agent()?.runtime} size={props.size ?? 24} muted={props.muted} />;
}

export function SenderFace(props: { m: ChatMessage; size?: number }) {
  const core = useCore();
  const session = () => core()?.sessions.find((s) => s.id === (props.m.session ?? props.m.from));
  return (
    <Switch>
      <Match when={props.m.actor.kind === "user"}>
        <UserFace size={props.size ?? 36} />
      </Match>
      <Match when={actorRoleOf(props.m.actor) === "orchestrator"}>
        <OrchestratorFace size={props.size ?? 36} agent={props.m.from} />
      </Match>
      <Match when={actorRoleOf(props.m.actor) === "worker" || props.m.actor.kind === "system"}>
        <HelperFace agent={props.m.agent ?? session()?.agent ?? props.m.from} runtime={session()?.runtime} size={props.size ?? 36} />
      </Match>
    </Switch>
  );
}

export function ThinkingDots() {
  return (
    <span class="inline-flex items-center gap-1" aria-hidden="true">
      <For each={[0, 150, 300]}>
        {(d) => (
          <span
            class={[
              "w-1.5 h-1.5 bg-faint motion-safe:[animation-name:thinking-bounce] motion-safe:[animation-duration:1000ms] motion-safe:[animation-delay:0ms] motion-safe:[animation-timing-function:ease] motion-safe:[animation-iteration-count:infinite] motion-safe:[animation-direction:normal] motion-safe:[animation-fill-mode:none] motion-safe:[animation-play-state:running]",
              "[animation-duration:900ms]",
            ]}
            style={viewStyles.thinkingTiming(d)}
          />
        )}
      </For>
    </span>
  );
}

export function Count(props: { n: number }) {
  return <span class="shrink-0 rounded-full bg-accent px-1.5 text-xs font-semibold text-page tabular-nums">{props.n}</span>;
}
