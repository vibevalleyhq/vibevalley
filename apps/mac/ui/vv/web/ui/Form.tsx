// Ported from VibeValley apps/web/src/ui/Form.tsx. There is no <form>:
// `Form` gives its children a `submit` to call (a submit button, Return in
// a field), and the summary of what is wrong sits under them. Moving the
// focus to the first wrong field after a refused submit is not ported
// (nsh has no query over the views); formControl gives what nsh's inputs take.
import { Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";

import type { FormField as Binding } from "../infra/form";
import { Hint } from "./Tip";

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

/** children: given the form's submit, for the button and for Return in a field. */
export function Form(props: { form: Controls; children: (submit: () => void) => JSX.Element; class?: string | undefined; testid?: string }) {
  const submit = () => void props.form.submit();
  return (
    <View testID={props.testid} accessibilityState={{ busy: props.form.submitting() }} class={props.class}>
      {props.children(submit)}
      <If when={props.form.messages().length > 0 || props.form.submitError() !== undefined}>
        <Text role="alert" class="mt-2 text-sm text-berry">
          {props.form.submitError() ?? props.form.messages().join(" · ")}
        </Text>
      </If>
    </View>
  );
}

/** What a field's input takes from its binding: leaving it marks it touched. */
export function formControl<V>(field: Binding<V>) {
  return { onBlur: field.blur };
}

export function FormField(props: { field: Pick<Binding<unknown>, "id" | "messages">; label: string; hint?: string; children: JSX.Element }) {
  return (
    <View class="gap-1">
      <View class="flex-row items-center gap-1.5">
        <Text class="text-xs font-medium text-muted">{props.label}</Text>
        <If when={props.hint}>{(hint) => <Hint text={hint()} />}</If>
      </View>
      {props.children}
      <If when={props.field.messages().length > 0}>
        <Text class="text-xs text-berry">{props.field.messages().join(" · ")}</Text>
      </If>
    </View>
  );
}
