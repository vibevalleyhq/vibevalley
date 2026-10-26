import { issuesWording } from "./words";
import { wording } from "@vibevalley/protocol/words";
import { For, Match, Show, Switch } from "solid-js";
import { type IssueStatus, orchestratorAgent, type Priority } from "@vibevalley/protocol";
import type { BoardCard, Tone } from "../../rules/cards";
import { cardAgent } from "../../rules/cards";
import { AgentFace, OrchestratorFace } from "../../ui/Face";
import { useAgent } from "../../data/agents";

export const toneVar = (t: Tone) => `var(--color-${t})`;

const statusTone: Record<IssueStatus, Tone> = { backlog: "faint", todo: "muted", in_progress: "water", in_review: "wheat", done: "leaf", canceled: "faint" };

/** A ring that fills as the work goes on, as Linear draws it. */
export function StatusMark(props: { status: IssueStatus; size?: number; tone?: Tone; label?: string }) {
  const size = () => props.size ?? 14;
  const color = () => toneVar(props.tone ?? statusTone[props.status]);
  const c = () => size() / 2;
  const r = () => size() / 2 - 1;
  const u = () => r() / 2.2;
  const part = () => (props.status === "in_progress" ? 0.5 : 0.75);
  const pie = () => {
    const pr = r() - 2.5;
    const a = -Math.PI / 2 + 2 * Math.PI * part();
    return `M${c()},${c()} L${c()},${c() - pr} A${pr},${pr} 0 ${part() > 0.5 ? 1 : 0} 1 ${c() + pr * Math.cos(a)},${c() + pr * Math.sin(a)} Z`;
  };
  return (
    <svg
      width={size()}
      height={size()}
      viewBox={`0 0 ${size()} ${size()}`}
      role="img"
      aria-label={props.label ?? wording().status[props.status]}
      class="shrink-0"
    >
      <Switch
        fallback={
          <>
            <circle cx={c()} cy={c()} r={r() + 0.75} fill={color()} />
            <Show
              when={props.status === "done"}
              fallback={
                <path
                  d={`M${c() - u() * 0.7},${c() - u() * 0.7} L${c() + u() * 0.7},${c() + u() * 0.7} M${c() + u() * 0.7},${c() - u() * 0.7} L${c() - u() * 0.7},${c() + u() * 0.7}`}
                  stroke="var(--color-page)"
                  stroke-width={1.5}
                  stroke-linecap="round"
                />
              }
            >
              <path
                d={`M${c() - u()},${c()} L${c() - u() * 0.25},${c() + u() * 0.75} L${c() + u()},${c() - u() * 0.6}`}
                fill="none"
                stroke="var(--color-page)"
                stroke-width={1.5}
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </Show>
          </>
        }
      >
        <Match when={props.status === "backlog"}>
          <circle
            cx={c()}
            cy={c()}
            r={r()}
            fill="none"
            stroke={color()}
            stroke-width={1.5}
            stroke-dasharray={`${(Math.PI * r()) / 4} ${(Math.PI * r()) / 4}`}
          />
        </Match>
        <Match when={props.status === "todo"}>
          <circle cx={c()} cy={c()} r={r()} fill="none" stroke={color()} stroke-width={1.5} />
        </Match>
        <Match when={props.status === "in_progress" || props.status === "in_review"}>
          <circle cx={c()} cy={c()} r={r()} fill="none" stroke={color()} stroke-width={1.5} />
          <path d={pie()} fill={color()} />
        </Match>
      </Switch>
    </svg>
  );
}

/** Bars that rise with the priority; urgent is a filled berry square with a bang, so it stands out on a busy lane. */
export function PriorityMark(props: { priority: Priority; size?: number }) {
  const s = () => props.size ?? 14;
  const label = () => issuesWording().marks.priority(wording().priority[props.priority]);
  const lit = () => (props.priority === "high" ? 3 : props.priority === "medium" ? 2 : 1);
  const w = () => s() / 5;
  return (
    <svg width={s()} height={s()} viewBox={`0 0 ${s()} ${s()}`} role="img" aria-label={label()} class="shrink-0">
      <title>{label()}</title>
      <Show
        when={props.priority === "urgent"}
        fallback={
          <For each={[0, 1, 2]}>
            {(i) => {
              const h = () => s() * (0.35 + 0.25 * i);
              return (
                <rect
                  x={1 + i * (w() + w() / 2)}
                  y={s() - 1.5 - h()}
                  width={w()}
                  height={h()}
                  rx={1}
                  fill={i < lit() ? "var(--color-muted)" : "var(--color-line)"}
                />
              );
            }}
          </For>
        }
      >
        <rect x={1} y={1} width={s() - 2} height={s() - 2} rx={3} fill="var(--color-berry)" />
        <rect x={s() / 2 - 0.9} y={s() * 0.24} width={1.8} height={s() * 0.34} rx={0.9} fill="var(--color-page)" />
        <circle cx={s() / 2} cy={s() * 0.72} r={1.1} fill="var(--color-page)" />
      </Show>
    </svg>
  );
}

/** A task's steps: a ring that fills as they settle, and the count. */
export function ProgressMark(props: { done: number; total: number }) {
  const part = () => (props.total === 0 ? 0 : Math.min(1, props.done / props.total));
  const r = 5.5;
  const len = 2 * Math.PI * r;
  return (
    <span class="inline-flex items-center gap-1 text-[11px] leading-[14px] text-muted">
      <svg width={13} height={13} viewBox="0 0 13 13" aria-hidden="true" class="-rotate-90">
        <circle cx={6.5} cy={6.5} r={r} fill="none" stroke="var(--color-line)" stroke-width={2} />
        <Show when={part() > 0}>
          <circle cx={6.5} cy={6.5} r={r} fill="none" stroke="var(--color-leaf)" stroke-width={2} stroke-dasharray={`${len * part()} ${len}`} />
        </Show>
      </svg>
      {props.done}/{props.total}
    </span>
  );
}

/** Nobody picked yet: Linear's unassigned, a dashed ring round a small person. */
export function NoFaceMark(props: { size?: number }) {
  const s = () => props.size ?? 16;
  const c = () => s() / 2;
  const r = () => s() / 2 - 1;
  return (
    <svg width={s()} height={s()} viewBox={`0 0 ${s()} ${s()}`} role="img" aria-label={issuesWording().noHelper} class="shrink-0">
      <title>{issuesWording().noHelper}</title>
      <circle
        cx={c()}
        cy={c()}
        r={r()}
        fill="none"
        stroke="var(--color-faint)"
        stroke-width={1.2}
        stroke-dasharray={`${(Math.PI * r()) / 4} ${(Math.PI * r()) / 4}`}
      />
      <circle cx={c()} cy={c() - s() * 0.12} r={s() * 0.13} fill="var(--color-faint)" />
      <path
        d={`M${c() - s() * 0.25},${c() + s() * 0.3} A${s() * 0.25},${s() * 0.2} 0 0 1 ${c() + s() * 0.25},${c() + s() * 0.3} Z`}
        fill="var(--color-faint)"
      />
    </svg>
  );
}

/** A small flag on a card or row: only the things the owner should notice. */
export function FlagChip(props: { text: string; tone: Tone }) {
  return (
    <span
      class="rounded px-1.5 text-[11px] leading-4 font-medium whitespace-nowrap"
      style={{ background: `color-mix(in srgb, ${toneVar(props.tone)} 18%, transparent)` }}
    >
      {props.text}
    </span>
  );
}

/** A helper's head by its id, its look read from the profiles. */
export function AgentFaceOf(props: { agent: string; runtime?: string; size?: number }) {
  const found = useAgent(() => props.agent);
  return (
    <Show when={props.agent !== orchestratorAgent} fallback={<OrchestratorFace size={props.size ?? 18} />}>
      <span title={found()?.name ?? props.agent} class="inline-flex">
        <AgentFace agentId={props.agent} runtime={props.runtime ?? found()?.runtime} look={found()?.look} size={props.size ?? 18} />
      </span>
    </Show>
  );
}

/** Who works it: the helper's face, the orchestrator's head, or a dashed circle for nobody yet. A task has none. */
export function CardFace(props: { card: BoardCard; size?: number }) {
  const size = () => props.size ?? 18;
  return (
    <Switch
      fallback={
        <Show when={cardAgent(props.card)} fallback={<NoFaceMark size={size() - 2} />}>
          {(agent) => (
            <AgentFaceOf
              agent={agent()}
              runtime={props.card.kind === "issue" ? (props.card.session ?? props.card.sessions.at(-1))?.runtime : undefined}
              size={size()}
            />
          )}
        </Show>
      }
    >
      <Match when={props.card.kind === "task"}>{null}</Match>
      <Match when={props.card.kind === "orchestrator"}>
        <OrchestratorFace size={size()} />
      </Match>
    </Switch>
  );
}
