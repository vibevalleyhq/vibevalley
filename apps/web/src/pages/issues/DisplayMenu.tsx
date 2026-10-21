import { useEffect, useRef, useState } from "react";
import { type BoardLook, defaultLook, groupingLabel, groupings, orderingLabel, orderings } from "../../rules/board";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";

/** 显示: a small panel under its button with how the list groups and how both views order. */
export function DisplayMenu({ look, onChange }: { look: BoardLook; onChange: (l: BoardLook) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const changed = look.grouping !== defaultLook.grouping || look.ordering !== defaultLook.ordering;
  const notes = [
    look.view === "board" && "看板总按状态分列，拖过去就改状态；分组用在列表上。",
    look.ordering !== "manual" && "不是「默认」排序时，待办不能上下拖着排先后。",
    look.view !== "board" && look.ordering === "manual" && "「默认」是待办里你排的先后。",
  ].filter(Boolean);
  return (
    <div ref={box} className="relative">
      <Button tone="quiet" icon="button-settings" aria-expanded={open} onClick={() => setOpen(!open)}>
        显示
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="显示"
          className="absolute top-full right-0 z-30 mt-1.5 w-[min(340px,calc(100vw-24px))] rounded-lg border border-line bg-page p-3 shadow-float"
        >
          <div className="flex items-center gap-2">
            <span className="w-10 shrink-0 text-sm text-muted">分组</span>
            <Segmented
              label="分组"
              block
              value={look.grouping}
              onChange={(grouping) => onChange({ ...look, grouping })}
              options={groupings.map((g) => ({ value: g, label: groupingLabel[g] }))}
            />
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <span className="w-10 shrink-0 text-sm text-muted">排序</span>
            <Segmented
              label="排序"
              block
              value={look.ordering}
              onChange={(ordering) => onChange({ ...look, ordering })}
              options={orderings.map((o) => ({ value: o, label: orderingLabel[o] }))}
            />
          </div>
          {notes.length > 0 && <p className="mt-2.5 text-xs leading-relaxed whitespace-pre-line text-muted">{notes.join("\n")}</p>}
          {changed && (
            <button
              type="button"
              onClick={() => onChange({ ...look, grouping: defaultLook.grouping, ordering: defaultLook.ordering })}
              className="mt-2 cursor-pointer text-sm text-water hover:underline"
            >
              恢复默认
            </button>
          )}
        </div>
      )}
    </div>
  );
}
