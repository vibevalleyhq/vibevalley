import type { Phase, SessionAction } from "@vibevalley/protocol";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { cx } from "./base";

// No line icons and no characters standing in for icons: the pixel font has no ✓, ✗ or ›.

/** A drawing from apps/web/public/pixel; decorative unless it has a label. */
export function SpriteIcon({ name, size, label, className, style }: { name: string; size: number; label?: string; className?: string; style?: CSSProperties }) {
  return (
    <img
      src={`/pixel/${name}.png`}
      width={size}
      height={size}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      draggable={false}
      className={cx("inline-block shrink-0 object-contain [image-rendering:pixelated]", className)}
      style={{ width: size, height: size, ...style }}
    />
  );
}

export function ActionGlyph({ action, size = 16 }: { action: SessionAction; size?: number }) {
  return action === "none" ? null : <SpriteIcon name={`act-${action}`} size={size} />;
}

export function PhaseGlyph({ phase, size = 16 }: { phase: Phase; size?: number }) {
  switch (phase._tag) {
    case "arriving":
      return <SpriteIcon name="icon-seeds" size={size} />;
    case "working":
      return phase.doing.action === "none" ? (
        <span className="inline-block shrink-0" style={{ width: size, height: size }} />
      ) : (
        <Bob>
          <SpriteIcon name={`act-${phase.doing.action}`} size={size} />
        </Bob>
      );
    case "ripe":
      return <SpriteIcon name="icon-harvest" size={size} />;
    case "failed":
      return <SpriteIcon name="icon-bug" size={size} />;
    case "resting":
      return <SpriteIcon name="act-wait" size={size} />;
    case "closed":
      return <SpriteIcon name={phase.closed === "merged" ? "icon-harvest" : "act-wait"} size={size} />;
  }
}

export function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** Two frames, no tween, so the pixels stay whole; still when the system asks for less motion. */
function Bob({ children }: { children: ReactNode }) {
  const still = useReducedMotion();
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (still) {
      setUp(false);
      return;
    }
    const beat = setInterval(() => setUp((u) => !u), 450);
    return () => clearInterval(beat);
  }, [still]);
  return <span className={cx("inline-flex shrink-0", up && "-translate-y-px")}>{children}</span>;
}

/** A sprite before a line, at its first line's height. */
export function Marked({ mark, children, size = 12, top = 2 }: { mark: string; children: ReactNode; size?: number; top?: number }) {
  return (
    <span className="inline-flex min-w-0 items-start gap-1.5">
      <SpriteIcon name={mark} size={size} style={{ marginTop: top }} />
      <span className="min-w-0">{children}</span>
    </span>
  );
}
