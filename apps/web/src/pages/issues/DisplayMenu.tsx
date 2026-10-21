import { createEffect, createSignal, Show } from "solid-js";
import { type BoardLook, defaultLook, groupingLabel, groupings, orderingLabel, orderings } from "../../rules/board";
import { aria } from "../../app/util";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";

/** 显示: a small panel under its button with how the list groups and how both views order. */
export function DisplayMenu(props: { look: BoardLook; onChange: (l: BoardLook) => void }) {
  const [open, setOpen] = createSignal(false);
  let box!: HTMLDivElement;
  createEffect(open, (on) => {
    if (!on) return;
    const away = (e: PointerEvent) => {
      if (!box.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  });
  const changed = () => props.look.grouping !== defaultLook.grouping || props.look.ordering !== defaultLook.ordering;
  const notes = () =>
    [
      props.look.view === "board" && "看板总按状态分列，拖过去就改状态；分组用在列表上。",
      props.look.ordering !== "manual" && "不是「默认」排序时，待办不能上下拖着排先后。",
      props.look.view !== "board" && props.look.ordering === "manual" && "「默认」是待办里你排的先后。",
    ].filter(Boolean);
  return (
    <div ref={(el) => (box = el)} class="relative">
      <Button tone="quiet" icon="button-settings" aria-expanded={aria(open())} onClick={() => setOpen(!open())}>
        显示
      </Button>
      <Show when={open()}>
        <div
          role="dialog"
          aria-label="显示"
          class="absolute top-full right-0 z-30 mt-1.5 w-[min(340px,calc(100vw-24px))] rounded-lg border border-line bg-page p-3 shadow-float"
        >
          <div class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-sm text-muted">分组</span>
            <Segmented
              label="分组"
              block
              value={props.look.grouping}
              onChange={(grouping) => props.onChange({ ...props.look, grouping })}
              options={groupings.map((g) => ({ value: g, label: groupingLabel[g] }))}
            />
          </div>
          <div class="mt-2.5 flex items-center gap-2">
            <span class="w-10 shrink-0 text-sm text-muted">排序</span>
            <Segmented
              label="排序"
              block
              value={props.look.ordering}
              onChange={(ordering) => props.onChange({ ...props.look, ordering })}
              options={orderings.map((o) => ({ value: o, label: orderingLabel[o] }))}
            />
          </div>
          <Show when={notes().length > 0}>
            <p class="mt-2.5 text-xs leading-relaxed whitespace-pre-line text-muted">{notes().join("\n")}</p>
          </Show>
          <Show when={changed()}>
            <button
              type="button"
              onClick={() => props.onChange({ ...props.look, grouping: defaultLook.grouping, ordering: defaultLook.ordering })}
              class="mt-2 cursor-pointer text-sm text-water hover:underline"
            >
              恢复默认
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
