import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { ChangedFile } from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { changeKind, patchLines, patchMarkOf } from "#/features/issue/index.ts";
import { SpriteIcon } from "#/ui/pixel/index.ts";

export function FarmTag(props: { text: string; class?: JSX.ClassValue | undefined; icon?: string; goes?: boolean }) {
  return (
    <span class={["inline-flex items-center gap-1 bg-cream-200 px-2 py-0.5 text-(length:--text-xs) whitespace-nowrap text-bark-800", props.class]}>
      <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={12} />}</Show>
      {props.text}
      <Show when={props.goes}>
        <SpriteIcon name="button-next" size={10} />
      </Show>
    </span>
  );
}

export function Tinted(props: { children: JSX.Element; class?: JSX.ClassValue | undefined; style?: JSX.CSSProperties }) {
  return (
    <div class={["bg-cream-100 px-3 py-2", props.class]} style={props.style}>
      {props.children}
    </div>
  );
}

export function FarmEmpty(props: { text: string }) {
  return <div class="bg-cream-100 px-4 py-8 text-center text-(length:--text-sm) text-bark-600">{props.text}</div>;
}

/** Hours and minutes of a time. */
export { farmClock as clockOf } from "#/farm/store.ts";

export function PlusMinus(props: { added: number; removed: number }) {
  return (
    <span class="font-mono text-[length:12.5px] whitespace-nowrap">
      <span class="text-leaf-700">+{props.added}</span>
      <span class="text-berry"> −{props.removed}</span>
    </span>
  );
}

const fileLook: Record<string, JSX.ClassValue> = {
  A: "bg-diff-add-fill text-leaf-700",
  M: "bg-diff-mod-fill text-bark-800",
  D: "bg-diff-del-fill text-berry-500",
};

const patchLook = {
  added: "bg-patch-add-bg text-leaf-700",
  removed: "bg-patch-del-bg text-berry-500",
  hunk: "text-water-500",
  plain: "text-bark-800",
} as const;

function Patch(props: { text: string }) {
  return (
    <div class="mx-2 mb-2 max-h-80 overflow-auto bg-cream-50 py-1">
      <For each={patchLines(props.text)} keyed={false}>
        {(line) => <div class={["px-2 font-mono text-[length:12.5px] leading-[1.4] whitespace-pre", patchLook[patchMarkOf(line())]]}>{line() || " "}</div>}
      </For>
    </div>
  );
}

export function FileRow(props: { file: ChangedFile; conflict: boolean }) {
  const [open, setOpen] = createSignal(false);
  const kind = () => changeKind(props.file.status);
  return (
    <div class="bg-cream-100">
      <button
        type="button"
        aria-label={props.file.path}
        aria-expanded={props.file.patch ? aria(open()) : undefined}
        disabled={!props.file.patch}
        onClick={() => setOpen(!open())}
        class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left enabled:cursor-pointer enabled:hover:bg-cream-200"
      >
        <span
          title={kind().label}
          class={["flex h-5 w-5 shrink-0 items-center justify-center text-(length:--text-xs)", fileLook[props.file.status] ?? "bg-cream-200 text-bark-800"]}
        >
          {kind().mark}
        </span>
        <span title={props.file.path} class={["min-w-0 flex-1 truncate font-mono text-[length:12.5px]", props.conflict ? "text-berry" : "text-bark-800"]}>
          {props.file.path}
        </span>
        <Show when={props.conflict}>
          <FarmTag text={t("web.farm.conflictTag")} class="bg-[color-mix(in_srgb,_var(--color-berry-500)_15%,_var(--color-cream-50))] text-berry-500" />
        </Show>
        <Show when={props.file.added >= 0} fallback={<span class="font-mono text-[length:12.5px] text-bark-500">{t("web.farm.binary")}</span>}>
          <PlusMinus added={Math.round(props.file.added)} removed={Math.round(props.file.removed)} />
        </Show>
      </button>
      <Show when={open() && props.file.patch}>{(patch) => <Patch text={patch()} />}</Show>
    </div>
  );
}
