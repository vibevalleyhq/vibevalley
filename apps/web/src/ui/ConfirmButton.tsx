import { createSignal, Show } from "solid-js";
import { t } from "@vibevalley/i18n";
import { Button } from "./Button";
import type { IconName } from "./icons";

/**
 * A button for what cannot be taken back (docs/style/design.md, 对话框和确认): the first press asks in place, the
 * question, the action's own button and a way back; Escape or the focus leaving takes it back. No window.confirm.
 * question: what will happen, as the owner reads it; confirm: the action's button (the label when absent).
 */
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
        class="flex animate-fade-in flex-wrap items-center gap-2"
        onKeyDown={(e) => e.key === "Escape" && setArmed(false)}
        // Leaving the group takes the question back; moving between its buttons does not.
        onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setArmed(false)}
      >
        <Show when={props.question}>
          <span class="text-sm text-muted">{props.question}</span>
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
