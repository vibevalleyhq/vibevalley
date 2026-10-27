import { issuesWording } from "./words";
import { createEffect, createSignal, Show } from "solid-js";
import { type BoardLook, defaultLook, groupingLabel, groupings, orderingLabel, orderings } from "./display";
import { aria } from "../../base/util";
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
      props.look.view === "board" && issuesWording().display.boardNote,
      props.look.ordering !== "manual" && issuesWording().display.orderNote,
      props.look.view !== "board" && props.look.ordering === "manual" && issuesWording().display.defaultNote,
    ].filter(Boolean);
  return (
    <div ref={(el) => (box = el)} class="relative">
      <Button tone="quiet" icon="button-settings" aria-expanded={aria(open())} onClick={() => setOpen(!open())}>
        {issuesWording().display.show}
      </Button>
      <Show when={open()}>
        <div
          role="dialog"
          aria-label={issuesWording().display.show}
          class="absolute top-full right-0 z-30 mt-1.5 w-[min(340px,calc(100vw-24px))] rounded-lg border border-line bg-page p-3 shadow-float"
        >
          <div class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-sm text-muted">{issuesWording().display.group}</span>
            <Segmented
              label={issuesWording().display.group}
              block
              value={props.look.grouping}
              onChange={(grouping) => props.onChange({ ...props.look, grouping })}
              options={groupings.map((g) => ({ value: g, label: groupingLabel[g] }))}
            />
          </div>
          <div class="mt-2.5 flex items-center gap-2">
            <span class="w-10 shrink-0 text-sm text-muted">{issuesWording().display.order}</span>
            <Segmented
              label={issuesWording().display.order}
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
              {issuesWording().display.reset}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
