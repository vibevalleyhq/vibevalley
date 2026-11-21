// Ported from VibeValley apps/web/src/features/issue/views/Marks.tsx: the
// SVG marks are drawn on nsh Canvas (no SVG in nsh) with the same
// geometry; colors are the theme tokens the CSS variables named. Faces are
// ui/domain/Face's (an initial until the pixel sprites are drawn here).
import { Canvas, colorScheme, Path2D, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { IssueStatus, Priority } from "@vibevalley/protocol";

import { useAgent } from "../../../infra/agents";
import { AgentFace, OrchestratorFace } from "../../../ui/domain/Face";
import { Bubble } from "../../../ui/Tip";
import { mix, tone } from "../../../ui/tone";
import type { BoardCard, Tone } from "../model/cards";
import { cardAgent } from "../model/cards";

const statusTone: Record<IssueStatus, Tone> = { backlog: "faint", todo: "muted", in_progress: "water", in_review: "wheat", done: "leaf", canceled: "faint" };

/** A ring that fills as the work goes on, as Linear draws it. */
export function StatusMark(props: { status: IssueStatus; size?: number; tone?: Tone | undefined; label?: string }) {
  const size = () => props.size ?? 14;
  const color = () => tone(props.tone ?? statusTone[props.status]);
  const page = () => tone("page");
  return (
    <Canvas
      accessible
      role="image"
      accessibilityLabel={props.label ?? t(`shared.status.${props.status}`)}
      style={{ width: size(), height: size(), flexShrink: 0 }}
      draw={(cx) => {
        void colorScheme();
        const s = size();
        const status = props.status;
        const col = color();
        const pg = page();
        const c = s / 2;
        const r = s / 2 - 1;
        const u = r / 2.2;
        cx.lineWidth = 1.5;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        if (status === "backlog" || status === "todo" || status === "in_progress" || status === "in_review") {
          cx.strokeStyle = col;
          if (status === "backlog") cx.setLineDash([(Math.PI * r) / 4, (Math.PI * r) / 4]);
          cx.beginPath();
          cx.arc(c, c, r, 0, Math.PI * 2);
          cx.stroke();
          cx.setLineDash([]);
          if (status === "in_progress" || status === "in_review") {
            const part = status === "in_progress" ? 0.5 : 0.75;
            const pr = r - 2.5;
            const a = -Math.PI / 2 + 2 * Math.PI * part;
            cx.fillStyle = col;
            cx.fill(new Path2D(`M${c},${c} L${c},${c - pr} A${pr},${pr} 0 ${part > 0.5 ? 1 : 0} 1 ${c + pr * Math.cos(a)},${c + pr * Math.sin(a)} Z`));
          }
          return;
        }
        cx.fillStyle = col;
        cx.beginPath();
        cx.arc(c, c, r + 0.75, 0, Math.PI * 2);
        cx.fill();
        cx.strokeStyle = pg;
        cx.stroke(
          new Path2D(
            status === "done"
              ? `M${c - u},${c} L${c - u * 0.25},${c + u * 0.75} L${c + u},${c - u * 0.6}`
              : `M${c - u * 0.7},${c - u * 0.7} L${c + u * 0.7},${c + u * 0.7} M${c + u * 0.7},${c - u * 0.7} L${c - u * 0.7},${c + u * 0.7}`,
          ),
        );
      }}
    />
  );
}

/** Bars that rise with the priority; urgent is a filled berry square with a bang, so it stands out on a busy lane. */
export function PriorityMark(props: { priority: Priority; size?: number }) {
  const s = () => props.size ?? 14;
  const label = () => t("web.issue.marks.priority", { word: t(`shared.priority.${props.priority}`) });
  const lit = () => (props.priority === "high" ? 3 : props.priority === "medium" ? 2 : 1);
  return (
    <Canvas
      accessible
      role="image"
      accessibilityLabel={label()}
      tooltip={<Bubble text={label()} />}
      style={{ width: s(), height: s(), flexShrink: 0 }}
      draw={(cx) => {
        void colorScheme();
        const size = s();
        const priority = props.priority;
        const bars = lit();
        const page = tone("page");
        const berry = tone("berry");
        const muted = tone("muted");
        const line = tone("line");
        if (priority === "urgent") {
          cx.fillStyle = berry;
          cx.beginPath();
          cx.roundRect(1, 1, size - 2, size - 2, 3);
          cx.fill();
          cx.fillStyle = page;
          cx.beginPath();
          cx.roundRect(size / 2 - 0.9, size * 0.24, 1.8, size * 0.34, 0.9);
          cx.fill();
          cx.beginPath();
          cx.arc(size / 2, size * 0.72, 1.1, 0, Math.PI * 2);
          cx.fill();
          return;
        }
        const w = size / 5;
        for (const i of [0, 1, 2]) {
          const h = size * (0.35 + 0.25 * i);
          cx.fillStyle = i < bars ? muted : line;
          cx.beginPath();
          cx.roundRect(1 + i * (w + w / 2), size - 1.5 - h, w, h, 1);
          cx.fill();
        }
      }}
    />
  );
}

/** A task's steps: a ring that fills as they settle, and the count. */
export function ProgressMark(props: { done: number; total: number }) {
  const part = () => (props.total === 0 ? 0 : Math.min(1, props.done / props.total));
  return (
    <View class="flex-row items-center gap-1">
      <Canvas
        style={{ width: 13, height: 13, flexShrink: 0 }}
        draw={(cx) => {
          void colorScheme();
          const frac = part();
          const line = tone("line");
          const leaf = tone("leaf");
          cx.lineWidth = 2;
          cx.strokeStyle = line;
          cx.beginPath();
          cx.arc(6.5, 6.5, 5.5, 0, Math.PI * 2);
          cx.stroke();
          if (frac <= 0) return;
          cx.strokeStyle = leaf;
          cx.beginPath();
          cx.arc(6.5, 6.5, 5.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
          cx.stroke();
        }}
      />
      <Text class="text-2xs text-muted" style={{ fontVariant: ["tabular-nums"] }}>{`${props.done}/${props.total}`}</Text>
    </View>
  );
}

/** Nobody picked yet: Linear's unassigned, a dashed ring round a small person. */
export function NoFaceMark(props: { size?: number }) {
  const s = () => props.size ?? 16;
  return (
    <Canvas
      accessible
      role="image"
      accessibilityLabel={t("web.issue.noHelper")}
      style={{ width: s(), height: s(), flexShrink: 0 }}
      draw={(cx) => {
        void colorScheme();
        const size = s();
        const faint = tone("faint");
        const c = size / 2;
        const r = size / 2 - 1;
        cx.strokeStyle = faint;
        cx.lineWidth = 1.2;
        cx.setLineDash([(Math.PI * r) / 4, (Math.PI * r) / 4]);
        cx.beginPath();
        cx.arc(c, c, r, 0, Math.PI * 2);
        cx.stroke();
        cx.setLineDash([]);
        cx.fillStyle = faint;
        cx.beginPath();
        cx.arc(c, c - size * 0.12, size * 0.13, 0, Math.PI * 2);
        cx.fill();
        cx.fill(new Path2D(`M${c - size * 0.25},${c + size * 0.3} A${size * 0.25},${size * 0.2} 0 0 1 ${c + size * 0.25},${c + size * 0.3} Z`));
      }}
    />
  );
}

const flagStyles: Record<Tone, { bgClass: string; bgStyle?: () => string; text: string }> = {
  leaf: { bgClass: "bg-ok-soft", text: "text-ok-ink" },
  berry: { bgClass: "bg-bad-soft", text: "text-berry" },
  wheat: { bgClass: "bg-warn-soft", text: "text-warn-ink" },
  water: { bgClass: "", bgStyle: () => mix("water", 0.16), text: "text-water" },
  muted: { bgClass: "", bgStyle: () => mix("muted", 0.14), text: "text-muted" },
  faint: { bgClass: "", bgStyle: () => mix("faint", 0.14), text: "text-muted" },
};

/** A small flag on a card or row: only the things the user should notice. */
export function FlagChip(props: { text: string; tone: Tone }) {
  const look = () => flagStyles[props.tone];
  const bgStyle = () => {
    const bg = look().bgStyle;
    return bg ? { backgroundColor: bg() } : undefined;
  };
  return (
    <View class={`rounded-sm px-1.5 ${look().bgClass}`} style={bgStyle()}>
      <Text class={`text-2xs font-medium ${look().text}`} style={{ lineHeight: 16, numberOfLines: 1 }}>
        {props.text}
      </Text>
    </View>
  );
}

/** A helper's face, or the orchestrator's head when the profile is one. */
export function AgentFaceOf(props: { agent: string; runtime?: string | undefined; size?: number }) {
  const found = useAgent(() => props.agent);
  return (
    <If when={found()?.role !== "orchestrator"} else={<OrchestratorFace size={props.size ?? 18} agent={props.agent} />}>
      <View accessible accessibilityLabel={found()?.name ?? props.agent} tooltip={<Bubble text={found()?.name ?? props.agent} />}>
        <AgentFace agentId={props.agent} name={found()?.name} runtime={props.runtime ?? found()?.runtime} look={found()?.look} size={props.size ?? 18} />
      </View>
    </If>
  );
}

/** Who works it: the helper's face, the orchestrator's head, or a dashed circle for nobody yet. A task has none. */
export function CardFace(props: { card: BoardCard; size?: number }) {
  const size = () => props.size ?? 18;
  return (
    <If
      when={props.card.kind === "orchestrator"}
      else={
        <If when={cardAgent(props.card)} else={<NoFaceMark size={size() - 2} />}>
          {(agent) => (
            <AgentFaceOf
              agent={agent()}
              runtime={props.card.kind === "issue" ? (props.card.session ?? props.card.sessions.at(-1))?.runtime : undefined}
              size={size()}
            />
          )}
        </If>
      }
    >
      <OrchestratorFace size={size()} />
    </If>
  );
}
