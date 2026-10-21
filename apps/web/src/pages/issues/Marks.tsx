import { type IssueStatus, managerAgent, type Priority } from "@vibevalley/protocol";
import { useAgents } from "../../data/agents";
import type { BoardCard, Tone } from "../../rules/cards";
import { cardAgent } from "../../rules/cards";
import { priorityLabel, statusLabel } from "../../rules/issues";
import { AgentFace, ManagerFace } from "../../ui/Face";

export const toneVar = (t: Tone) => `var(--color-${t})`;

const statusTone: Record<IssueStatus, Tone> = { backlog: "faint", todo: "muted", in_progress: "water", in_review: "wheat", done: "leaf", canceled: "faint" };

/** A ring that fills as the work goes on, as Linear draws it. */
export function StatusMark({ status, size = 14, tone, label }: { status: IssueStatus; size?: number; tone?: Tone; label?: string }) {
  const color = toneVar(tone ?? statusTone[status]);
  const c = size / 2;
  const r = size / 2 - 1;
  let inner = null;
  if (status === "backlog")
    inner = <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray={`${(Math.PI * r) / 4} ${(Math.PI * r) / 4}`} />;
  else if (status === "todo") inner = <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={1.5} />;
  else if (status === "in_progress" || status === "in_review") {
    const part = status === "in_progress" ? 0.5 : 0.75;
    const pr = r - 2.5;
    const a = -Math.PI / 2 + 2 * Math.PI * part;
    inner = (
      <>
        <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={1.5} />
        <path d={`M${c},${c} L${c},${c - pr} A${pr},${pr} 0 ${part > 0.5 ? 1 : 0} 1 ${c + pr * Math.cos(a)},${c + pr * Math.sin(a)} Z`} fill={color} />
      </>
    );
  } else {
    const u = r / 2.2;
    inner = (
      <>
        <circle cx={c} cy={c} r={r + 0.75} fill={color} />
        {status === "done" ? (
          <path
            d={`M${c - u},${c} L${c - u * 0.25},${c + u * 0.75} L${c + u},${c - u * 0.6}`}
            fill="none"
            stroke="var(--color-page)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d={`M${c - u * 0.7},${c - u * 0.7} L${c + u * 0.7},${c + u * 0.7} M${c + u * 0.7},${c - u * 0.7} L${c - u * 0.7},${c + u * 0.7}`}
            stroke="var(--color-page)"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        )}
      </>
    );
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? statusLabel[status]} className="shrink-0">
      {inner}
    </svg>
  );
}

/** Bars that rise with the priority; urgent is a filled berry square with a bang, so it stands out on a busy lane. */
export function PriorityMark({ priority, size = 14 }: { priority: Priority; size?: number }) {
  const s = size;
  const label = `优先级：${priorityLabel[priority]}`;
  if (priority === "urgent")
    return (
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} role="img" aria-label={label} className="shrink-0">
        <title>{label}</title>
        <rect x={1} y={1} width={s - 2} height={s - 2} rx={3} fill="var(--color-berry)" />
        <rect x={s / 2 - 0.9} y={s * 0.24} width={1.8} height={s * 0.34} rx={0.9} fill="var(--color-page)" />
        <circle cx={s / 2} cy={s * 0.72} r={1.1} fill="var(--color-page)" />
      </svg>
    );
  const lit = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  const w = s / 5;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} role="img" aria-label={label} className="shrink-0">
      <title>{label}</title>
      {[0, 1, 2].map((i) => {
        const h = s * (0.35 + 0.25 * i);
        return <rect key={i} x={1 + i * (w + w / 2)} y={s - 1.5 - h} width={w} height={h} rx={1} fill={i < lit ? "var(--color-muted)" : "var(--color-line)"} />;
      })}
    </svg>
  );
}

/** A task's steps: a ring that fills as they settle, and the count. */
export function ProgressMark({ done, total }: { done: number; total: number }) {
  const part = total === 0 ? 0 : Math.min(1, done / total);
  const r = 5.5;
  const len = 2 * Math.PI * r;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] leading-[14px] text-muted">
      <svg width={13} height={13} viewBox="0 0 13 13" aria-hidden className="-rotate-90">
        <circle cx={6.5} cy={6.5} r={r} fill="none" stroke="var(--color-line)" strokeWidth={2} />
        {part > 0 && <circle cx={6.5} cy={6.5} r={r} fill="none" stroke="var(--color-leaf)" strokeWidth={2} strokeDasharray={`${len * part} ${len}`} />}
      </svg>
      {done}/{total}
    </span>
  );
}

/** Nobody picked yet: Linear's unassigned, a dashed ring round a small person. */
export function NoFaceMark({ size = 16 }: { size?: number }) {
  const s = size;
  const c = s / 2;
  const r = s / 2 - 1;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} role="img" aria-label="还没选帮工" className="shrink-0">
      <title>还没选帮工</title>
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--color-faint)" strokeWidth={1.2} strokeDasharray={`${(Math.PI * r) / 4} ${(Math.PI * r) / 4}`} />
      <circle cx={c} cy={c - s * 0.12} r={s * 0.13} fill="var(--color-faint)" />
      <path d={`M${c - s * 0.25},${c + s * 0.3} A${s * 0.25},${s * 0.2} 0 0 1 ${c + s * 0.25},${c + s * 0.3} Z`} fill="var(--color-faint)" />
    </svg>
  );
}

/** A small flag on a card or row: only the things the owner should notice. */
export function FlagChip({ text, tone }: { text: string; tone: Tone }) {
  return (
    <span
      className="rounded px-1.5 text-[11px] leading-4 font-medium whitespace-nowrap"
      style={{ background: `color-mix(in srgb, ${toneVar(tone)} 18%, transparent)` }}
    >
      {text}
    </span>
  );
}

/** A helper's head by its id, its look read from the profiles. */
export function AgentFaceOf({ agent, size = 18 }: { agent: string; size?: number }) {
  const found = useAgents().data?.find((a) => a.id === agent);
  if (agent === managerAgent) return <ManagerFace size={size} />;
  return (
    <span title={found?.name ?? agent} className="inline-flex">
      <AgentFace agentId={agent} look={found?.look} size={size} />
    </span>
  );
}

/** Who works it: the helper's face, the manager's head, or a dashed circle for nobody yet. A task has none. */
export function CardFace({ card, size = 18 }: { card: BoardCard; size?: number }) {
  if (card.kind === "task") return null;
  if (card.kind === "manager") return <ManagerFace size={size} />;
  const agent = cardAgent(card);
  return agent ? <AgentFaceOf agent={agent} size={size} /> : <NoFaceMark size={size - 2} />;
}
