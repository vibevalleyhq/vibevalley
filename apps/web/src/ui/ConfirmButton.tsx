import * as stylex from "@stylexjs/stylex";
import { createSignal, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { Button } from "./Button";
import type { IconName } from "./icons";

const fadeIn = stylex.keyframes({
  from: { opacity: 0 },
});

const viewStyles = stylex.create({
  group: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
    animationName: { default: fadeIn, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "180ms",
    animationTimingFunction: "var(--ease-out)",
    animationFillMode: "both",
  },
  confirmButtonSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
});

/** A button for what cannot be taken back (docs/style/design.md): the first press asks in place, the question, the action's own button and a way back. */
export function ConfirmButton(props: {
  label: string;
  question?: string;
  confirm?: string;
  tone?: "danger" | "primary";
  icon?: IconName;
  title?: string;
  disabled?: boolean;
  /** The first press's test id; the confirming one's is it with -sure. */
  testid?: string;
  onConfirm: () => unknown;
}) {
  const [armed, setArmed] = createSignal(false);
  return (
    <Show
      when={armed()}
      fallback={
        <Button icon={props.icon} title={props.title} disabled={props.disabled} data-testid={props.testid} onClick={() => setArmed(true)}>
          {props.label}
        </Button>
      }
    >
      <span
        role="group"
        {...stylex.attrs(viewStyles.group)}
        onKeyDown={(e) => e.key === "Escape" && setArmed(false)}
        // Leaving the group takes the question back; moving between its buttons does not.
        onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget instanceof Node ? e.relatedTarget : null) && setArmed(false)}
      >
        <Show when={props.question}>
          <span {...stylex.attrs(viewStyles.confirmButtonSpan)}>{props.question}</span>
        </Show>
        <Button
          tone={props.tone ?? "danger"}
          disabled={props.disabled}
          data-testid={props.testid && `${props.testid}-sure`}
          ref={(el) => queueMicrotask(() => el.focus())}
          onClick={() => {
            setArmed(false);
            void props.onConfirm();
          }}
        >
          {props.confirm ?? props.label}
        </Button>
        <Button onClick={() => setArmed(false)}>{t("web.base.form.never")}</Button>
      </span>
    </Show>
  );
}
