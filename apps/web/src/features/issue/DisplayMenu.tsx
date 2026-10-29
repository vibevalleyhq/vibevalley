import { t } from "@vibevalley/i18n";

import { Popover } from "@vibevalley/base-ui";
import { Show } from "solid-js";
import { type BoardLook, defaultLook, groupingLabel, groupings, orderingLabel, orderings } from "./display";
import { Button } from "@/ui/Button";
import { Segmented } from "@/ui/Segmented";

/** 显示: a small panel under its button with how the list groups and how both views order. */
export function DisplayMenu(props: { look: BoardLook; onChange: (l: BoardLook) => void }) {
  const changed = () => props.look.grouping !== defaultLook.grouping || props.look.ordering !== defaultLook.ordering;
  const notes = () =>
    [
      props.look.view === "board" && t("web.issue.display.boardNote"),
      props.look.ordering !== "manual" && t("web.issue.display.orderNote"),
      props.look.view !== "board" && props.look.ordering === "manual" && t("web.issue.display.defaultNote"),
    ].filter(Boolean);
  return (
    <Popover.Root>
      <Popover.Trigger render={(p) => <Button {...p} tone="quiet" icon="settings" />} data-testid="display">
        {t("web.issue.display.show")}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} class="z-30">
          <Popover.Popup
            aria-label={t("web.issue.display.show")}
            data-testid="display-menu"
            class="w-[min(340px,calc(100vw-24px))] origin-top-right animate-pop-in rounded-lg border border-line bg-page p-3 shadow-float outline-none"
          >
            <div class="flex items-center gap-2">
              <span class="w-10 shrink-0 text-sm text-muted">{t("web.issue.display.group")}</span>
              <Segmented
                label={t("web.issue.display.group")}
                testid="grouping"
                block
                value={props.look.grouping}
                onChange={(grouping) => props.onChange({ ...props.look, grouping })}
                options={groupings.map((g) => ({ value: g, label: groupingLabel[g] }))}
              />
            </div>
            <div class="mt-2.5 flex items-center gap-2">
              <span class="w-10 shrink-0 text-sm text-muted">{t("web.issue.display.order")}</span>
              <Segmented
                label={t("web.issue.display.order")}
                testid="ordering"
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
                data-testid="display-reset"
                onClick={() => props.onChange({ ...props.look, grouping: defaultLook.grouping, ordering: defaultLook.ordering })}
                class="mt-2 cursor-pointer text-sm text-water hover:underline"
              >
                {t("web.issue.display.reset")}
              </button>
            </Show>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
