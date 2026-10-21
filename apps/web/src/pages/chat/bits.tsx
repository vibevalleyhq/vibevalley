import type { ReactNode } from "react";
import type { ChatMessage, Phase } from "@vibevalley/protocol";
import { useAgents } from "../../data/agents";
import { type DotTone, phaseIcon } from "../../rules/chat";
import { AgentFace, ManagerFace, OwnerFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";

const dotColor: Record<DotTone | "idle", string> = { leaf: "bg-leaf", berry: "bg-berry", wheat: "bg-wheat", idle: "bg-[#c8a46e]" };

/** A phase or the manager's mood: a round dot ringed in the page colour. */
export function Dot({ tone, size = 9, className = "" }: { tone: DotTone | "idle"; size?: number; className?: string }) {
  return (
    <span className={`inline-block shrink-0 rounded-full ring-2 ring-page ${dotColor[tone]} ${className}`} style={{ width: size, height: size }} aria-hidden />
  );
}

export function PhaseGlyph({ phase, size = 14 }: { phase: Phase; size?: number }) {
  const icon = phaseIcon(phase);
  if (!icon) return <span className="inline-block shrink-0" style={{ width: size, height: size }} />;
  return <Icon name={icon} size={size} />;
}

/** A helper's face by its profile's look; for a sender without a profile, by its id. */
export function HelperFace({ agent, size = 24, muted }: { agent: string; size?: number; muted?: boolean }) {
  const look = useAgents().data?.find((a) => a.id === agent)?.look;
  return <AgentFace agentId={agent} look={look} size={size} muted={muted} />;
}

export function SenderFace({ m, size = 36 }: { m: ChatMessage; size?: number }) {
  switch (m.fromKind) {
    case "user":
      return <OwnerFace size={size} />;
    case "manager":
      return <ManagerFace size={size} />;
    case "agent":
    case "system":
      return <HelperFace agent={m.agent ?? m.from} size={size} />;
  }
}

export function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {[0, 150, 300].map((d) => (
        <span key={d} className="size-1.5 bg-faint motion-safe:animate-bounce" style={{ animationDelay: `${d}ms`, animationDuration: "900ms" }} />
      ))}
    </span>
  );
}

export function StreamingCaret() {
  return <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-ink motion-safe:animate-pulse" aria-hidden />;
}

export function Count({ n }: { n: number }) {
  return <span className="shrink-0 rounded-full bg-accent px-1.5 text-xs font-semibold text-page tabular-nums">{n}</span>;
}

export function Tag({ icon, label, fill }: { icon?: string; label: string; fill: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-px text-xs font-medium" style={{ background: fill }}>
      {icon && <Icon name={icon} size={12} />}
      {label}
    </span>
  );
}

export function Empty({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-96 flex-col items-center gap-3 text-center text-sm text-muted">
        <Icon name={icon} size={48} className="opacity-80" />
        {children}
      </div>
    </div>
  );
}
