import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { cx, DashedLine, pxText, pxWindow } from "./base";
import { PxButton } from "./button";
import { SpriteIcon } from "./icons";

// The native modal dialog: the top layer, a focus trap and inert page behind. Escape and a click on the backdrop ask
// onClose; the dialog stays open until `open` turns false, so the caller owns it.
function Modal({
  open,
  onClose,
  label,
  backdrop,
  className,
  style,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  backdrop: string;
  className: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const live = useRef(open);
  live.current = open;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A browser may close it without a cancel (Escape pressed twice): the caller still hears of it.
      onClose={() => live.current && onClose()}
      onClick={(e) => e.target === ref.current && onClose()}
      style={style}
      className={cx(
        "m-auto max-h-none max-w-none overflow-visible bg-cream-50 p-0 text-bark-900",
        pxWindow,
        "transition-[opacity,scale] duration-150 starting:scale-95 starting:opacity-0 motion-reduce:transition-none",
        backdrop,
        className,
      )}
    >
      {open && children}
    </dialog>
  );
}

const farmSizes = {
  sm: "w-[min(480px,calc(100vw-24px))] h-[min(384px,88dvh)]",
  md: "w-[min(480px,calc(100vw-24px))] h-[min(608px,88dvh)]",
  lg: "w-[min(736px,calc(100vw-24px))] h-[min(576px,88dvh)]",
} as const;

export type FarmDialogSize = keyof typeof farmSizes;

/** A farm panel's frame: whatever it holds, it keeps its size and scrolls inside. Shown while `open` (default) is true. */
export function FarmDialog({
  title,
  size,
  icon,
  open = true,
  onClose,
  children,
}: {
  title: string;
  size: FarmDialogSize;
  icon?: string;
  open?: boolean;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} label={title} backdrop="backdrop:bg-bark-900/30" className={farmSizes[size]}>
      <div className={cx(pxText.sm, "flex h-full flex-col overflow-hidden")}>
        <div className="flex shrink-0 items-center gap-2 bg-cream-100 px-4 py-2.5">
          {icon && <SpriteIcon name={icon} size={32} />}
          <h2 className={cx(pxText.lg, "min-w-0 flex-1 truncate")}>{title}</h2>
          <button
            type="button"
            aria-label="关上"
            onClick={onClose}
            className="group grid size-9 shrink-0 cursor-pointer place-items-center outline-none hover:bg-cream-200 focus-visible:outline-2 focus-visible:outline-leaf-500 focus-visible:outline-solid"
          >
            <SpriteIcon name="button-close" size={18} className="group-active:translate-x-px group-active:translate-y-px" />
          </button>
        </div>
        <div className="shrink-0 bg-cream-100">
          <DashedLine />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </Modal>
  );
}

export function FarmSection({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="flex flex-col pt-4">
      <h3 className={cx(pxText.xs, "mb-1.5 text-bark-600")}>{title}</h3>
      {children}
    </section>
  );
}

/** A settings dialog: at most 512 px wide, as tall as it needs up to 85 % of the screen. */
export function PxDialog({ title, open = true, onClose, children }: { title: string; open?: boolean; onClose: () => void; children?: ReactNode }) {
  return (
    <Modal open={open} onClose={onClose} label={title} backdrop="backdrop:bg-[#1e140a73]" className="w-[min(512px,calc(100vw-32px))] border-2 border-bark-500">
      <div className={cx(pxText.sm, "max-h-[85dvh] overflow-y-auto p-6")}>
        <div className="mb-5 flex items-center gap-3">
          <h2 className={cx(pxText.xl, "min-w-0 flex-1")}>{title}</h2>
          <PxButton size="icon" label="关上" onClick={onClose}>
            <SpriteIcon name="button-close" size={16} />
          </PxButton>
        </div>
        {children}
      </div>
    </Modal>
  );
}

/** A page's own modal, opened by its route rather than pushed over it: the address stays the page's. */
export function PxModalLayer({
  label,
  open = true,
  onClose,
  maxWidth = 720,
  children,
}: {
  label: string;
  open?: boolean;
  onClose: () => void;
  maxWidth?: number;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      label={label}
      backdrop="backdrop:bg-[#1e140a73]"
      className="border-2 border-bark-500"
      style={{ width: `min(${maxWidth}px, calc(100vw - 32px))` }}
    >
      <div className="relative">
        {/* The top leaves room for the close button, so a title under it is never covered. */}
        <div className={cx(pxText.sm, "max-h-[88dvh] overflow-y-auto px-6 pt-10 pb-6")}>{children}</div>
        <PxButton size="icon" label="关上" onClick={onClose} className="absolute top-2 right-2">
          <SpriteIcon name="button-close" size={16} />
        </PxButton>
      </div>
    </Modal>
  );
}
