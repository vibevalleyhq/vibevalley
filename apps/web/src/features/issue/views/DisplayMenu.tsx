import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { Popover } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";

import { type BoardLook, defaultLook, groupingLabel, groupings, orderingLabel, orderings } from "#/features/issue/model/display.ts";
import { Button } from "#/ui/Button.tsx";
import { positionerAttrs } from "#/ui/positioner.ts";
import { Segmented } from "#/ui/Segmented.tsx";

const popIn = stylex.keyframes({
  from: { opacity: 0, scale: 0.98 },
});

const styles = stylex.create({
  displayMenuPopoverPopup: {
    width: "min(340px,100vw - 24px)",
    transformOrigin: "100% 0",
    animationName: { default: popIn, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "280ms",
    animationTimingFunction: "var(--ease-out)",
    animationFillMode: "both",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    padding: "0.75rem",
    boxShadow: "var(--shadow-float)",
    outlineStyle: "none",
  },
  displayMenuDiv: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  displayMenuSpan: {
    width: "2.5rem",
    flexShrink: "0",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  displayMenuDiv2: {
    marginTop: "0.625rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  displayMenuP: {
    marginTop: "0.625rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-relaxed)",
    whiteSpace: "pre-line",
    color: "var(--color-muted)",
  },
  displayReset: {
    marginTop: "0.5rem",
    cursor: "pointer",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-water)",
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
          <Popover.Popup aria-label={t("web.issue.display.show")} data-testid="display-menu" {...stylex.attrs(styles.displayMenuPopoverPopup)}>
            <div {...stylex.attrs(styles.displayMenuDiv)}>
              <span {...stylex.attrs(styles.displayMenuSpan)}>{t("web.issue.display.group")}</span>
              <Segmented
                label={t("web.issue.display.group")}
                testid="grouping"
                block
                value={props.look.grouping}
                onChange={(grouping) => props.onChange({ ...props.look, grouping })}
                options={groupings.map((g) => ({ value: g, label: groupingLabel[g] }))}
              />
            </div>
            <div {...stylex.attrs(styles.displayMenuDiv2)}>
              <span {...stylex.attrs(styles.displayMenuSpan)}>{t("web.issue.display.order")}</span>
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
              <p {...stylex.attrs(styles.displayMenuP)}>{notes().join("\n")}</p>
            </Show>
            <Show when={changed()}>
              <button
                type="button"
                data-testid="display-reset"
                onClick={() => props.onChange({ ...props.look, grouping: defaultLook.grouping, ordering: defaultLook.ordering })}
                {...stylex.attrs(styles.displayReset)}
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
