import { t } from "@vibevalley/i18n";
import type { KeySource, KeyStatus } from "@vibevalley/protocol";
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Icon } from "./Icon";
import { IconButton, IconLink } from "./IconButton";
import { Hint, Tip } from "./Tip";

// A key or an id the owner sets. Whether it is in use is a mark, where it comes from is said on hover; removing one
// marks it until the form is saved, and can be taken back until then.

const fromText = (s: KeySource) => t(`web.base.form.from.${s}`);

/** In use (and from where), not set, or to be removed on save. */
export function KeyMark(props: { status: KeyStatus; removing?: boolean }) {
  const text = () =>
    props.removing
      ? t("web.base.form.removeOnSave")
      : props.status.source
        ? props.status.hint
          ? t("web.base.form.inUse", { hint: props.status.hint, from: fromText(props.status.source) })
          : t("web.base.form.fromOnly", { from: fromText(props.status.source) })
        : t("web.base.form.unset");
  return (
    <Tip text={text()}>
      <span
        role="img"
        data-testid="key-mark"
        data-state={props.removing ? "removing" : (props.status.source ?? "unset")}
        data-hint={props.status.hint}
        aria-label={text()}
        tabindex={0}
        class="inline-flex rounded outline-none focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Show when={props.removing || props.status.source} fallback={<span class="m-[3px] block size-2 rounded-full border border-faint" aria-hidden="true" />}>
          <Icon name={props.removing ? "cross" : "check"} size={14} />
        </Show>
      </span>
    </Tip>
  );
}

export function KeyField(props: {
  label: string;
  status: KeyStatus;
  removing: boolean;
  /** Marks the key for removal, or takes the mark back. */
  onRemove: (removing: boolean) => void;
  /** Where the key is made. */
  link?: { readonly href: string; readonly label: string };
  tip?: string;
  /** A label as small as the fields' around it in a dense form. */
  small?: boolean;
  children: JSX.Element;
}) {
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center gap-1.5">
        <span class={props.small ? "text-xs font-medium text-muted" : "text-sm font-semibold"}>{props.label}</span>
        <KeyMark status={props.status} removing={props.removing} />
        <Show when={props.tip}>{(t) => <Hint text={t()} />}</Show>
        <span class="flex-1" />
        <Show when={props.link}>{(l) => <IconLink href={l().href} label={l().label} />}</Show>
      </div>
      <div class="flex items-center gap-1">
        <div class={["min-w-0 flex-1", { "pointer-events-none opacity-40": props.removing }]}>{props.children}</div>
        <Show when={props.status.source === "settings"}>
          <IconButton
            icon={props.removing ? "undo" : "delete"}
            tone={props.removing ? undefined : "danger"}
            label={props.removing ? t("web.base.form.keepKey", { label: props.label }) : t("web.base.form.removeKey", { label: props.label })}
            onClick={() => props.onRemove(!props.removing)}
          />
        </Show>
      </div>
    </div>
  );
}

/** Save and undo, shown while there is something to save; `left` says what went wrong. */
export function SaveBar(props: { dirty: boolean; busy: boolean; onSave: () => void; onUndo: () => void; left?: JSX.Element; extra?: JSX.Element }) {
  return (
    <div data-testid="save-bar" data-dirty={props.dirty ? "" : undefined} class="sticky bottom-0 flex items-center gap-2 border-t border-line bg-page py-2.5">
      <div class="min-w-0 flex-1 text-sm">{props.left}</div>
      {props.extra}
      <Show when={props.dirty}>
        <button
          type="button"
          data-testid="undo"
          onClick={() => props.onUndo()}
          class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-sm text-muted hover:bg-hover hover:text-ink"
        >
          <Icon name="undo" size={14} />
          {t("web.base.form.undo")}
        </button>
      </Show>
      <button
        type="submit"
        data-testid="save"
        disabled={!props.dirty || props.busy}
        onClick={(e) => {
          e.preventDefault();
          props.onSave();
        }}
        class="inline-flex h-7 cursor-pointer items-center rounded-md border border-accent bg-accent px-2.5 text-sm text-page hover:bg-leaf disabled:cursor-default disabled:opacity-50"
      >
        {t("web.base.form.save")}
      </button>
    </div>
  );
}
