import { issuesWording } from "./words";
import { createSignal, For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Tone } from "../../rules/cards";
import { type Stage, stageLabel, stages } from "../../rules/issues";
import { aria, useSelectValue } from "../../base/util";
import { Icon } from "../../ui/Icon";
import { toneVar } from "./Marks";

/** An issue laid out as a page: what it is and the talk about it on the left, its properties and actions on the right.
 * Too narrow for two, the properties come after it: what is asked of the owner stays on the first screen. */
export function IssueSheet(props: { heading: JSX.Element; main: JSX.Element; side: JSX.Element }) {
  return (
    <div class="@container">
      {props.heading}
      <div class="mt-4 flex flex-col gap-4 @min-[760px]:flex-row @min-[760px]:items-start @min-[760px]:gap-6">
        <div class="flex min-w-0 flex-1 flex-col">{props.main}</div>
        <aside class="flex flex-col rounded-lg bg-hover p-3 @min-[760px]:w-[260px] @min-[760px]:shrink-0 @min-[760px]:rounded-none @min-[760px]:border-l @min-[760px]:border-line @min-[760px]:bg-transparent @min-[760px]:py-0 @min-[760px]:pr-0 @min-[760px]:pl-5">
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
      <div class="min-w-0 flex-1 break-words">{props.children}</div>
    </div>
  );
}

/** A second-level part: folded until asked for, its summary beside the label. */
export function Fold(props: { label: string; summary?: string; open?: boolean; leading?: JSX.Element; children: JSX.Element }) {
  const [open, setOpen] = createSignal(untrack(() => props.open ?? false));
  return (
    <div class="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={aria(open())}
        onClick={() => setOpen(!open())}
        class="flex w-full cursor-pointer items-center gap-2 py-2.5 text-left hover:bg-hover"
      >
        <Icon name="button-next" size={10} class={["transition-transform", { "rotate-90": open() }]} />
        {props.leading}
        <span class="shrink-0 text-sm font-semibold">{props.label}</span>
        <Show when={props.summary}>
          <span class="min-w-0 truncate text-xs text-muted">{props.summary}</span>
        </Show>
      </button>
      {/* Mounted with the page and only hidden while folded: content first mounted by the click reads queries in flight,
          and Solid holds that click's whole update until they land, so the fold would not open. */}
      <div class="pb-3 pl-5" hidden={!open()}>
        {props.children}
      </div>
    </div>
  );
}

/** The properties asked about less often, behind 更多. */
export function More(props: { children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="mt-1">
      <button type="button" onClick={() => setOpen(!open())} class="flex cursor-pointer items-center gap-1.5 py-1 text-xs text-muted hover:text-ink">
        <Icon name="button-next" size={8} class={{ "rotate-90": open() }} />
        {open() ? issuesWording().sheet.less : issuesWording().sheet.more}
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
export function Note(props: { tone?: Tone; children: JSX.Element; class?: string }) {
  return (
    <div
      class={["rounded-lg px-3.5 py-3 text-sm", props.class]}
      style={{ background: props.tone ? `color-mix(in srgb, ${toneVar(props.tone)} 16%, transparent)` : "var(--color-hover)" }}
    >
      {props.children}
    </div>
  );
}

/** 聊清楚 → 安排活 → 完成, the one it is at marked. */
export function Stages(props: { at: Stage }) {
  const ati = () => stages.indexOf(props.at);
  return (
    <div class="flex items-center text-sm" aria-label={issuesWording().sheet.at(stageLabel[props.at])}>
      <For each={stages}>
        {(s, i) => (
          <div class={["flex items-center", { "flex-1": i() > 0 }]}>
            <Show when={i() > 0}>
              <div class={["mx-2 h-px flex-1", i() <= ati() ? "bg-leaf" : "bg-line"]} />
            </Show>
            <span class="flex items-center gap-1.5 whitespace-nowrap">
              <Show when={i() < ati()} fallback={<span class={["size-2 rounded-full", s === props.at ? "bg-wheat" : "bg-line"]} />}>
                <Icon name="mark-check" size={12} label={issuesWording().sheet.stageDone(stageLabel[s])} />
              </Show>
              <span class={s === props.at ? "font-semibold text-ink" : i() < ati() ? "text-accent" : "text-faint"}>{stageLabel[s]}</span>
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

/** A small menu-like pick in the side column. */
export function Pick(props: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const ref = useSelectValue(
    () => props.value,
    () => props.options,
  );
  return (
    <select
      ref={ref}
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.currentTarget.value)}
      class="-ml-2 h-7 w-[calc(100%+8px)] cursor-pointer rounded-md border border-transparent bg-transparent px-1.5 text-sm outline-none hover:border-line hover:bg-page focus:border-focus disabled:cursor-default disabled:opacity-60"
    >
      <Show when={props.placeholder !== undefined}>
        <option value="">{props.placeholder}</option>
      </Show>
      <For each={props.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
    </select>
  );
}
