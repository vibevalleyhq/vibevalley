import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";

import { formIssues, type FormIssue } from "./issues";
import { at, immutable, replace, type FormValue, type Path, type PathValue } from "./paths";

export type Submission<R> =
  | { readonly kind: "accepted"; readonly receipt: R }
  | { readonly kind: "rejected"; readonly message: string; readonly issues?: readonly FormIssue[] }
  | { readonly kind: "unknown"; readonly message: string };
export type Attempt = { readonly revision: number; readonly attemptId: string };
export type SubmitResult<R> = (Submission<R> & Attempt) | { readonly kind: "busy" | "composing" | "outdated" | "invalid" | "unavailable" | "disposed" };
export type FormOptions<T, E extends FormValue, R> = {
  readonly schema: Schema.Codec<T, E>;
  readonly defaultValues: E;
  readonly messages: { issue: (issue: FormIssue) => string; unavailable: string; unknown: string };
  readonly onSubmit: (value: T, attempt: Attempt) => Promise<Submission<R>>;
};
export type FormSnapshot<E> = {
  readonly values: E;
  readonly baseline: E;
  readonly revision: number;
  readonly validating: boolean;
  readonly submitting: boolean;
  readonly submitted: boolean;
  readonly composing: boolean;
  readonly touched: ReadonlySet<string>;
  readonly issues: readonly FormIssue[];
  readonly submitError: string | undefined;
};
export type FormField<V> = {
  readonly id: string;
  value: () => V;
  setValue: (value: V) => void;
  touched: () => boolean;
  dirty: () => boolean;
  issues: () => readonly FormIssue[];
  messages: () => readonly string[];
  blur: () => void;
};
const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value: unknown, index) => equal(value, b[index]));
  if (Predicate.isObject(a) && Predicate.isObject(b))
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
  return false;
};

export function createForm<T, E extends FormValue, R>(options: FormOptions<T, E, R>) {
  const initial = immutable(options.defaultValues);
  const prefix = `form-${crypto.randomUUID()}`;
  let current: FormSnapshot<E> = {
    values: initial,
    baseline: initial,
    revision: 0,
    validating: false,
    submitting: false,
    submitted: false,
    composing: false,
    touched: new Set(),
    issues: [],
    submitError: undefined,
  };
  const listeners = new Set<() => void>();
  let closed = false;
  let validation = 0;
  let controller: AbortController | undefined;
  let scheduled = false;
  const update = (patch: Partial<FormSnapshot<E>>) => {
    current = { ...current, ...patch };
    for (const listener of listeners) listener();
  };
  const cancelValidation = () => {
    validation++;
    controller?.abort();
    controller = undefined;
  };
  type Decoded = { kind: "valid"; value: T } | { kind: "invalid" | "outdated" | "unavailable" | "disposed" };
  const validate = async (): Promise<Decoded> => {
    if (closed) return { kind: "disposed" };
    cancelValidation();
    const id = validation;
    const revision = current.revision;
    const task = new AbortController();
    controller = task;
    const input = current.values;
    update({ validating: true });
    const result = await Effect.runPromiseExit(Schema.decodeUnknownEffect(options.schema, { errors: "all" })(input), { signal: task.signal });
    if (closed) return { kind: "disposed" };
    if (id !== validation || revision !== current.revision) return { kind: "outdated" };
    controller = undefined;
    if (Exit.isSuccess(result)) {
      update({ validating: false, issues: [] });
      return { kind: "valid", value: result.value };
    }
    const error = Cause.findErrorOption(result.cause);
    if (Option.isSome(error)) {
      update({ validating: false, issues: formIssues(error.value.issue) });
      return { kind: "invalid" };
    }
    update({ validating: false, submitError: options.messages.unavailable });
    return { kind: "unavailable" };
  };
  const revalidate = () => {
    if (!current.submitted || current.composing || scheduled || closed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!closed && !current.composing) void validate();
    });
  };
  const setValue = <const P extends Path<E>>(path: P, value: PathValue<E, P>) => {
    if (closed) return;
    const next = immutable(replace(current.values, path, value));
    if (equal(next, current.values)) return;
    cancelValidation();
    update({ values: next, revision: current.revision + 1, validating: false });
    revalidate();
  };
  const submit = async (): Promise<SubmitResult<R>> => {
    if (closed) return { kind: "disposed" };
    if (current.submitting) return { kind: "busy" };
    if (current.composing) return { kind: "composing" };
    const attempt = { revision: current.revision, attemptId: crypto.randomUUID() };
    update({ submitting: true, submitted: true, submitError: undefined });
    try {
      const decoded = await validate();
      if (decoded.kind !== "valid") return decoded;
      if (attempt.revision !== current.revision) return { kind: "outdated" };
      let result: Submission<R>;
      try {
        result = await options.onSubmit(decoded.value, attempt);
      } catch {
        result = { kind: "unknown", message: options.messages.unknown };
      }
      if (!closed) {
        if (result.kind !== "accepted")
          update({
            submitError: result.message,
            ...(result.kind === "rejected" && result.issues && current.revision === attempt.revision ? { issues: result.issues } : {}),
          });
      }
      return { ...result, ...attempt };
    } finally {
      if (!closed) update({ submitting: false });
    }
  };
  const fields = new Map<string, string>();
  const field = <const P extends Path<E>>(path: P): FormField<PathValue<E, P>> => {
    at(current.values, path);
    const key = JSON.stringify(path);
    const id = fields.get(key) ?? `${prefix}-${fields.size}`;
    fields.set(key, id);
    const visible = () => current.submitted || current.touched.has(key);
    const issues = () => (visible() ? current.issues.filter((issue) => JSON.stringify(issue.path) === key) : []);
    return {
      id,
      value: () => at(current.values, path),
      setValue: (value) => setValue(path, value),
      touched: () => current.touched.has(key),
      dirty: () => !equal(at(current.values, path), at(current.baseline, path)),
      issues,
      messages: () => issues().map(options.messages.issue),
      blur: () => {
        if (closed) return;
        update({ touched: new Set([...current.touched, key]) });
        if (!current.composing) void validate();
      },
    };
  };
  return {
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    values: () => current.values,
    revision: () => current.revision,
    dirty: () => !equal(current.values, current.baseline),
    validating: () => current.validating,
    submitting: () => current.submitting,
    issues: () => current.issues,
    submitError: () => current.submitError,
    messages: () => (current.submitted ? current.issues.map(options.messages.issue) : []),
    setValue,
    field,
    validate,
    submit,
    composition: (active: boolean) => {
      if (closed) return;
      update({ composing: active });
      if (!active) revalidate();
    },
    reset: (input: E, condition?: { ifRevision: number }) => {
      if (closed || (condition && condition.ifRevision !== current.revision)) return false;
      cancelValidation();
      const values = immutable(input);
      update({
        values,
        baseline: values,
        revision: current.revision + 1,
        issues: [],
        touched: new Set(),
        submitted: false,
        validating: false,
        submitError: undefined,
      });
      return true;
    },
    dispose: () => {
      closed = true;
      cancelValidation();
      listeners.clear();
      fields.clear();
    },
  };
}
