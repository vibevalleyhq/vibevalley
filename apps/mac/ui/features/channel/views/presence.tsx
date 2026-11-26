import { Text, View } from "nsh";

import { type ChatMessage, type Phase, type SessionView } from "@vibevalley/protocol";
import { actorRoleOf, sessionProfile, spanText } from "@vibevalley/protocol/rules";

import { AgentFace, OrchestratorFace, UserFace } from "../../../design/domain/Face";
import { Icon, type IconSize } from "../../../design/Icon";
import { actionIcon, type IconName } from "../../../design/icons";
import { useAgent } from "../../../infra/agents";
import { useNow } from "../../../infra/base/dom";
import { useSession } from "../../../infra/frame";
import { localizeRuntimeError } from "../../../infra/runtimeError";

const span = spanText;

export { Dot } from "../../../design/Tag";

/** The server's words for what the session is doing, how long it has been quiet filled in by the clock. */
export function phaseText(h: SessionView, now: number) {
  const words = localizeRuntimeError(h.phaseText).text;
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
    <If when={phaseIcon(props.phase)} else={<View style={{ width: props.size ?? 14, height: props.size ?? 14, flexShrink: 0 }} />}>
      {(icon) => <Icon name={icon()} size={props.size ?? 14} tone="muted" />}
    </If>
  );
}

/** A helper's face by its profile's look; for a sender without a profile, by its id. */
export function HelperFace(props: { agent: string; runtime?: string | undefined; size?: number; muted?: boolean }) {
  const agent = useAgent(() => props.agent);
  const look = () => agent()?.look;
  return (
    <AgentFace
      agentId={props.agent}
      name={agent()?.name}
      look={look()}
      runtime={props.runtime ?? agent()?.runtime}
      size={props.size ?? 24}
      muted={props.muted}
    />
  );
}

export function SenderFace(props: { m: ChatMessage; size?: number }) {
  const session = useSession(() => props.m.session ?? props.m.from);
  const size = () => props.size ?? 36;
  const senderAgent = () => {
    const s = session();
    return props.m.agent ?? (s ? sessionProfile(s) : undefined) ?? props.m.from;
  };
  return (
    <If
      when={props.m.actor.kind === "user"}
      else={
        <If
          when={actorRoleOf(props.m.actor) === "orchestrator"}
          else={
            <If when={actorRoleOf(props.m.actor) === "worker" || props.m.actor.kind === "system"}>
              <HelperFace agent={senderAgent()} runtime={session()?.runtime} size={size()} />
            </If>
          }
        >
          <OrchestratorFace size={size()} agent={props.m.from} />
        </If>
      }
    >
      <UserFace size={size()} />
    </If>
  );
}

export function ThinkingDots() {
  const now = useNow(300);
  return (
    <View class="flex-row items-center gap-1" accessible={false}>
      <Each of={[0, 1, 2]} key={(d) => d}>
        {(d) => <View class="h-1.5 w-1.5 rounded-full bg-faint" style={{ opacity: Math.floor(now() / 300) % 3 === d() ? 1 : 0.4 }} />}
      </Each>
    </View>
  );
}

export function Count(props: { n: number }) {
  return (
    <View class="h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1.5">
      <Text class="font-mono text-2xs font-semibold text-page">{String(props.n)}</Text>
    </View>
  );
}
