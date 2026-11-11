import * as stylex from "@stylexjs/stylex";
import { For, Match, Show, Switch } from "solid-js";

import { type ChatMessage, type Phase, type SessionView } from "@vibevalley/protocol";
import { actorRoleOf, spanText } from "@vibevalley/protocol/rules";

import { useAgent } from "#/infra/agents.ts";
import { useCore } from "#/infra/frame.ts";
import { AgentFace, OrchestratorFace, UserFace } from "#/ui/domain/Face.tsx";
import { Icon, type IconSize } from "#/ui/Icon.tsx";
import { actionIcon, type IconName } from "#/ui/icons.ts";
import { styleProps } from "#/ui/positioner.ts";

const thinkingBounce = stylex.keyframes({
  "0%, 100%": { animationTimingFunction: "cubic-bezier(.8,0,1,1)", transform: "translateY(-25%)" },
  "50%": { animationTimingFunction: "cubic-bezier(0,0,.2,1)", transform: "none" },
});

const recipeStyles = stylex.create({
  thinkingDotsSpan: {
    width: "calc(var(--spacing) * 1.5)",
    height: "calc(var(--spacing) * 1.5)",
    backgroundColor: "var(--wb-faint)",
    animationName: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": thinkingBounce,
    },
    animationDuration: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "1s",
    },
    animationDelay: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "0s",
    },
    animationTimingFunction: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "ease",
    },
    animationIterationCount: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "infinite",
    },
    animationDirection: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "normal",
    },
    animationFillMode: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "none",
    },
    animationPlayState: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "running",
    },
  },
});

const viewStyles = stylex.create({
  glyphSize: (size: number) => ({ width: size, height: size }),
  thinkingTiming: (delay: number) => ({ animationDelay: `${delay}ms`, animationDuration: "900ms" }),
  phaseGlyphSpan: {
    display: "inline-block",
    flexShrink: "0",
  },
  thinkingDotsSpan: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--spacing)",
  },
  countSpan: {
    flexShrink: "0",
    borderRadius: "2147483647px",
    backgroundColor: "var(--color-accent)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-page)",
    fontVariantNumeric: "tabular-nums",
  },
});
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
    <Show when={phaseIcon(props.phase)} fallback={<span {...styleProps([viewStyles.phaseGlyphSpan, viewStyles.glyphSize(props.size ?? 14)])} />}>
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
    <span {...stylex.attrs(viewStyles.thinkingDotsSpan)} aria-hidden="true">
      <For each={[0, 150, 300]}>{(d) => <span {...styleProps([recipeStyles.thinkingDotsSpan, viewStyles.thinkingTiming(d)])} />}</For>
    </span>
  );
}

export function Count(props: { n: number }) {
  return <span {...stylex.attrs(viewStyles.countSpan)}>{props.n}</span>;
}
