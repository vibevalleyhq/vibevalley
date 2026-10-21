import { type ReactNode, useRef, useState, useSyncExternalStore } from "react";
import { cx, pxDrop, pxText } from "./base";
import { SpriteIcon } from "./icons";
import { type ToastData, type ToastStore, toasts } from "./toasts";

export function useToasts(store: ToastStore = toasts): readonly ToastData[] {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

const tone: Record<string, string> = { warn: "bg-[#f3b07a4d]", error: "bg-berry/15" };

/**
 * The stack of toasts, top centre over the page. The pointer over it holds their timeouts; a drag right or down past
 * 40 px closes the front one. `leading` and `kicker` replace the bell and add a line above the title (a medal, 解锁成就).
 */
export function ToastViewport({
  store = toasts,
  leading,
  kicker,
  top = 12,
}: {
  store?: ToastStore;
  leading?: (toast: ToastData) => ReactNode;
  kicker?: (toast: ToastData) => string | undefined;
  top?: number;
}) {
  const list = useToasts(store);
  return (
    // Only the cards take the pointer: around them (and with none shown) clicks go through to the page below.
    <div className="pointer-events-none fixed inset-x-0 z-50 flex justify-center" style={{ top }}>
      <div
        role="status"
        aria-live="polite"
        className="grid w-[min(320px,calc(100vw-32px))] [&>*]:[grid-area:1/1]"
        onMouseEnter={() => store.pause()}
        onMouseLeave={() => store.resume()}
      >
        {list.map((t, i) => (
          <ToastCard key={t.id} toast={t} index={i} hidden={i >= store.limit} leading={leading?.(t)} kicker={kicker?.(t)} onClose={() => store.close(t.id)} />
        ))}
      </div>
    </div>
  );
}

function ToastCard({
  toast: t,
  index: i,
  hidden,
  leading,
  kicker,
  onClose,
}: {
  toast: ToastData;
  index: number;
  hidden: boolean;
  leading?: ReactNode;
  kicker?: string;
  onClose: () => void;
}) {
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const from = useRef<{ x: number; y: number } | null>(null);
  const front = i === 0 && !hidden;
  return (
    <div
      // The newest is drawn on top; those behind it shrink and step down.
      style={{ zIndex: 100 - i, transform: `translate(${drag.x}px, ${i * 9.6 + drag.y}px) scale(${1 - i * 0.05})` }}
      className={cx(
        "flex origin-center items-center gap-3 self-start bg-cream-50 p-3 text-bark-900 touch-none",
        pxDrop,
        "transition-[translate,transform,opacity] duration-300 ease-out starting:-translate-y-[120%] motion-reduce:transition-none",
        (drag.x > 0 || drag.y > 0) && "transition-none",
        hidden ? "opacity-0" : "opacity-100",
        front ? "pointer-events-auto" : "pointer-events-none",
      )}
      onPointerDown={(e) => {
        from.current = { x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const f = from.current;
        if (f) setDrag({ x: Math.max(0, e.clientX - f.x), y: Math.max(0, e.clientY - f.y) });
      }}
      onPointerUp={() => {
        from.current = null;
        if (drag.x > 40 || drag.y > 40) onClose();
        else setDrag({ x: 0, y: 0 });
      }}
      onPointerCancel={() => {
        from.current = null;
        setDrag({ x: 0, y: 0 });
      }}
    >
      {leading ?? (
        <span className={cx("grid size-10 shrink-0 place-items-center", tone[t.type] ?? "bg-cream-200")}>
          <SpriteIcon name="icon-bell" size={32} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {kicker && <span className={cx(pxText.xs, "text-leaf-700")}>{kicker}</span>}
        <span className={pxText.sm}>{t.title}</span>
        {t.description && <span className={cx(pxText.xs, "text-bark-600")}>{t.description}</span>}
      </div>
    </div>
  );
}
