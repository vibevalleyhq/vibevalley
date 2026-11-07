import { onCleanup } from "solid-js";

import { createExternal } from "#/base/external.ts";

import { createForm, type FormOptions } from "./form/form";
import type { FormValue, Path } from "./form/paths";
export type { FormOptions, FormField, Submission } from "./form/form";

export function useForm<T, E extends FormValue, R>(options: FormOptions<T, E, R>) {
  const form = createForm(options);
  const state = createExternal(form.subscribe, form.snapshot);
  const track =
    <V>(read: () => V) =>
    () => {
      state();
      return read();
    };
  onCleanup(form.dispose);
  return {
    ...form,
    snapshot: state,
    values: track(form.values),
    revision: track(form.revision),
    dirty: track(form.dirty),
    validating: track(form.validating),
    submitting: track(form.submitting),
    issues: track(form.issues),
    messages: track(form.messages),
    submitError: track(form.submitError),
    field: <const P extends Path<E>>(path: P) => {
      const field = form.field(path);
      return {
        ...field,
        value: track(field.value),
        touched: track(field.touched),
        dirty: track(field.dirty),
        issues: track(field.issues),
        messages: track(field.messages),
      };
    },
  };
}
