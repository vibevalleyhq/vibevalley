import type { JSX } from "@solidjs/web";
import { createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";

import { aria } from "#/base/dom.tsx";
import type { Tone } from "#/features/issue/model/cards.ts";
import { type Stage, stageLabel, stages } from "#/features/issue/model/issue.ts";
import { Select } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";

import { toneVar } from "./Marks";

/** An issue laid out as a page: what it is and the talk about it on the left, its properties and actions on the right. */
export function IssueSheet(props: { heading: JSX.Element; main: JSX.Element; side: JSX.Element }) {
  return (
    <div class="@container">
      {props.heading}
      <div class="mt-4 flex flex-col @min-[760px]:flex-row gap-4 @min-[760px]:gap-6 @min-[760px]:items-start">
        <div class="flex min-w-0 flex-1 flex-col">{props.main}</div>
        <aside class="flex flex-col rounded-lg @min-[760px]:rounded-none bg-hover @min-[760px]:bg-transparent pt-3 @min-[760px]:pt-0 pr-3 @min-[760px]:pr-0 pb-3 @min-[760px]:pb-0 pl-3 @min-[760px]:pl-5 @min-[760px]:w-65 @min-[760px]:shrink-0 @min-[760px]:[border-left-style:solid] @min-[760px]:border-l @min-[760px]:border-line">
          {props.side}
        </aside>
      </div>
    </div>
  );
}

/** A label and its value, the label in a narrow muted column. */
export function Property(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex min-h-8 items-center gap-3 py-0.5 text-sm">
      <span class="w-16 shrink-0 text-muted">{props.label}</span>
      <div class="min-w-0 flex-1 wrap-break-word">{props.children}</div>
    </div>
  );
}

/** A second-level part: folded until asked for, its summary beside the label. */
export function Fold(props: { label: string; summary?: string | undefined; open?: boolean; leading?: JSX.Element; children: JSX.Element }) {
  const [open, setOpen] = createSignal(untrack(() => props.open ?? false));
  return (
    <div class="last:[border-bottom-style:solid] border-b last:border-b-0 border-line">
      <button
        type="button"
        aria-expanded={aria(open())}
        onClick={() => setOpen(!open())}
        class="flex w-full cursor-pointer items-center gap-2 py-2.5 text-left hover:bg-hover"
      >
        <Icon name="expand" size={10} class={["transition-[rotate] ease-out duration-180", open() ? "[rotate:90deg]" : ""]} />
        {props.leading}
        <span class="shrink-0 text-sm font-semibold">{props.label}</span>
        <Show when={props.summary}>
          <span class="min-w-0 truncate text-xs text-muted">{props.summary}</span>
        </Show>
      </button>
      {/* Mounted with the page and only hidden while folded. */}
      <div class="pb-3 pl-5" hidden={!open()}>
        {props.children}
      </div>
    </div>
  );
}

/** The properties asked about less often, behind More. */
export function More(props: { children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="mt-1">
      <button type="button" onClick={() => setOpen(!open())} class="flex cursor-pointer items-center gap-1.5 py-1 text-xs text-muted hover:text-ink">
        <Icon name="expand" size={10} class={["", open() ? "[rotate:90deg]" : ""]} />
        {open() ? t("web.issue.sheet.less") : t("web.issue.sheet.more")}
      </button>
      <Show when={open()}>
        <div class="mt-1">{props.children}</div>
      </Show>
    </div>
  );
}

export function SheetLabel(props: { children: JSX.Element }) {
  return <div class="mt-6 mb-1.5 text-xs font-semibold text-muted">{props.children}</div>;
}

/** A tinted box: the status, a conflict, nothing to merge. */
export function Note(props: { tone?: Tone; children: JSX.Element; class?: JSX.ClassValue | undefined }) {
  return (
    <div
      class={["rounded-lg px-3.5 py-3 text-sm", props.class]}
      style={{
        background: props.tone ? `color-mix(in srgb, ${toneVar(props.tone)} 16%, transparent)` : "var(--color-hover)",
      }}
    >
      {props.children}
    </div>
  );
}

/** Draft -> Active -> Done, the one it is at marked. */
export function Stages(props: { at: Stage }) {
  const ati = () => stages.indexOf(props.at);
  return (
    <div class="flex items-center text-sm" aria-label={t("web.issue.sheet.at", { stage: stageLabel[props.at] })}>
      <For each={stages}>
        {(s, i) => (
          <div class={["flex items-center", i() > 0 ? "flex-1" : ""]}>
            <Show when={i() > 0}>
              <div class={["mx-2 h-px flex-1", i() <= ati() ? "bg-leaf" : "bg-line"]} />
            </Show>
            <span class="flex items-center gap-1.5 whitespace-nowrap">
              <Show when={i() < ati()} fallback={<span class={["w-2 h-2 rounded-full", s === props.at ? "bg-wheat" : "bg-line"]} />}>
                <Icon name="check" size={12} label={t("web.issue.sheet.stageDone", { stage: stageLabel[s] })} />
              </Show>
              <span class={s === props.at ? "text-ink font-semibold" : i() < ati() ? "text-accent" : "text-faint"}>{stageLabel[s]}</span>
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

export function Pick<V extends string>(props: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  placeholder?: "" extends V ? string : never;
  onChange: (v: V) => void;
  disabled?: boolean;
  testid?: string;
  state?: "pending" | "failed" | undefined;
}) {
  return (
    <Select
      quiet
      size="control"
      class="-ml-2 w-[calc(100%_+_8px)]"
      label={props.label}
      value={props.value}
      options={props.options}
      placeholder={props.placeholder}
      onChange={props.onChange}
      disabled={props.disabled}
      testid={props.testid}
      state={props.state}
    />
  );
}
