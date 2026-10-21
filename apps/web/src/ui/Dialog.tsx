import { type ReactNode, useEffect, useRef } from "react";

/** A modal over the page (the native <dialog>: focus trap, Escape closes). Open while mounted with open. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={`m-auto rounded-lg border border-line bg-page p-0 text-ink shadow-float backdrop:bg-[#2f1f1340] ${wide ? "w-[min(1080px,94vw)]" : "w-[min(480px,92vw)]"}`}
    >
      {open && (
        <div className="flex max-h-[86vh] flex-col">
          <div className="border-b border-line px-5 py-3 text-base font-semibold">{title}</div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
        </div>
      )}
    </dialog>
  );
}
