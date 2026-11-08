import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { onCleanup, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import type { FormField as Binding } from "#/infra/form.ts";

import { styleProps } from "./positioner";
import { Hint } from "./Tip";

const viewStyles = stylex.create({
  formP: {
    marginTop: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-berry)",
  },
  formFieldDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  formFieldLabel: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-muted)",
  },
  formFieldP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-berry)",
  },
});

export const formMessages = {
  issue: () => t("web.base.form.invalid"),
  unavailable: t("web.base.form.validationUnavailable"),
  unknown: t("web.base.form.deliveryUnknown"),
};
type Controls = {
  submit: () => Promise<{ kind: string }>;
  submitting: () => boolean;
  composition: (active: boolean) => void;
  messages: () => readonly string[];
  submitError: () => string | undefined;
};
export function Form(props: { form: Controls; children: JSX.Element; styles?: stylex.StyleXStyles; testid?: string }) {
  let element: HTMLFormElement | undefined;
  let frame: number | undefined;
  let alive = true;
  onCleanup(() => {
    alive = false;
    if (frame !== undefined) cancelAnimationFrame(frame);
  });
  const submit = async () => {
    const result = await props.form.submit();
    if (!alive) return;
    if (result.kind === "invalid" || result.kind === "unavailable" || result.kind === "rejected" || result.kind === "unknown") {
      frame = requestAnimationFrame(() => element?.querySelector<HTMLElement>('[aria-invalid="true"], [data-form-summary]')?.focus());
    }
  };
  return (
    <form
      ref={(node) => {
        element = node;
      }}
      novalidate
      {...styleProps(props.styles)}
      data-testid={props.testid}
      aria-busy={props.form.submitting() ? "true" : undefined}
      onCompositionStart={() => props.form.composition(true)}
      onCompositionEnd={() => props.form.composition(false)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {props.children}
      <Show when={props.form.messages().length > 0 || props.form.submitError() !== undefined}>
        <p tabindex={-1} data-form-summary role="alert" {...stylex.attrs(viewStyles.formP)}>
          {props.form.submitError() ?? props.form.messages().join(" · ")}
        </p>
      </Show>
    </form>
  );
}
export function formControl<V>(field: Binding<V>) {
  return {
    id: field.id,
    onBlur: field.blur,
    "aria-invalid": field.issues().length > 0 ? ("true" as const) : undefined,
    "aria-describedby": field.issues().length > 0 ? `${field.id}-errors` : undefined,
  };
}
export function FormField(props: { field: Pick<Binding<unknown>, "id" | "messages">; label: string; hint?: string; children: JSX.Element }) {
  return (
    <div {...stylex.attrs(viewStyles.formFieldDiv)}>
      <label for={props.field.id} {...stylex.attrs(viewStyles.formFieldLabel)}>
        {props.label}
        <Show when={props.hint}>{(hint) => <Hint text={hint()} />}</Show>
      </label>
      {props.children}
      <Show when={props.field.messages().length > 0}>
        <p id={`${props.field.id}-errors`} {...stylex.attrs(viewStyles.formFieldP)}>
          {props.field.messages().join(" · ")}
        </p>
      </Show>
    </div>
  );
}
