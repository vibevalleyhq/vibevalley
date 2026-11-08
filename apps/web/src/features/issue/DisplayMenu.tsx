import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { Popover } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";

import { Button } from "#/ui/Button.tsx";
import { positionerAttrs } from "#/ui/positioner.ts";
import { Segmented } from "#/ui/Segmented.tsx";

import { type BoardLook, defaultLook, groupingLabel, groupings, orderingLabel, orderings } from "./display";

const viewStyles = stylex.create({
  displayMenuDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  displayMenuSpan: {
    width: "calc(var(--spacing) * 10)",
    flexShrink: "0",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  displayMenuDiv2: {
    marginTop: "calc(var(--spacing) * 2.5)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  displayMenuP: {
    marginTop: "calc(var(--spacing) * 2.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-relaxed)",
    whiteSpace: "pre-line",
    color: "var(--wb-muted)",
  },
  displayReset: {
    marginTop: "calc(var(--spacing) * 2)",
    cursor: "pointer",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-water)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
});

/** Display: a small panel under its button with how the list groups and how both views order. */
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
        <Popover.Positioner {...positionerAttrs()} align="end" sideOffset={6}>
          <Popover.Popup
            aria-label={t("web.issue.display.show")}
            data-testid="display-menu"
            class="w-[min(340px,calc(100vw-24px))] origin-top-right animate-pop-in rounded-lg border border-line bg-page p-3 shadow-float outline-none"
          >
            <div {...stylex.attrs(viewStyles.displayMenuDiv)}>
              <span {...stylex.attrs(viewStyles.displayMenuSpan)}>{t("web.issue.display.group")}</span>
              <Segmented
                label={t("web.issue.display.group")}
                testid="grouping"
                block
                value={props.look.grouping}
                onChange={(grouping) => props.onChange({ ...props.look, grouping })}
                options={groupings.map((g) => ({ value: g, label: groupingLabel[g] }))}
              />
            </div>
            <div {...stylex.attrs(viewStyles.displayMenuDiv2)}>
              <span {...stylex.attrs(viewStyles.displayMenuSpan)}>{t("web.issue.display.order")}</span>
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
              <p {...stylex.attrs(viewStyles.displayMenuP)}>{notes().join("\n")}</p>
            </Show>
            <Show when={changed()}>
              <button
                type="button"
                data-testid="display-reset"
                onClick={() => props.onChange({ ...props.look, grouping: defaultLook.grouping, ordering: defaultLook.ordering })}
                {...stylex.attrs(viewStyles.displayReset)}
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
