import { t } from "@vibevalley/i18n";
// Small pieces the farm's panels share: tags, tints, an empty note, a said line and its clock, and a harvest's line
// counts, file rows and patch.

import { createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ChangedFile } from "@vibevalley/protocol";
import { changeKind, patchLines, patchMarkOf } from "@/features/issue";
import { aria } from "@/base/util";
import { SpriteIcon } from "@/ui/pixel";

/** A colour at `alpha` of its strength over cream. */
export const tint = (hex: string, alpha: number) => `color-mix(in srgb, ${hex} ${Math.round(alpha * 100)}%, #f7e8c4)`;

export function FarmTag(props: { text: string; fill?: string; ink?: string; icon?: string; goes?: boolean }) {
  return (
    <span
      class="inline-flex items-center gap-1 px-2 py-0.5 text-[12px] whitespace-nowrap"
      style={{ background: props.fill ?? "#e2c995", color: props.ink ?? "#46301d" }}
    >
      <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={12} />}</Show>
      {props.text}
      <Show when={props.goes}>
        <SpriteIcon name="button-next" size={10} />
      </Show>
    </span>
  );
}

export function Tinted(props: { children: JSX.Element; color?: string; class?: string; style?: JSX.CSSProperties }) {
  return (
    <div class={["px-3 py-2", props.class]} style={{ background: props.color ?? "#eedcb2", ...props.style }}>
      {props.children}
    </div>
  );
}

export function FarmEmpty(props: { text: string }) {
  return <div class="bg-cream-100 px-4 py-8 text-center text-[13px] text-bark-600">{props.text}</div>;
}

/** What the server answered, under the button that asked. */
export function Said(props: { answer?: { ok: boolean | undefined; text: string } | undefined }) {
  return <Show when={props.answer}>{(a) => <p class={["mt-2 text-[12px]", a().ok === true ? "text-leaf-700" : "text-berry"]}>{a().text}</p>}</Show>;
}

/** Hours and minutes of a time. */
export function clockOf(at: number) {
  const d = new Date(Math.round(at));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function PlusMinus(props: { added: number; removed: number }) {
  return (
    <span class="font-mono text-[12.5px] whitespace-nowrap">
      <span class="text-leaf-700">+{props.added}</span>
      <span class="text-berry"> −{props.removed}</span>
    </span>
  );
}

const fileLook: Record<string, { fill: string; ink: string }> = {
  A: { fill: "#d0dca9", ink: "#3f6427" },
  M: { fill: "#f0dba9", ink: "#46301d" },
  D: { fill: "#edcba9", ink: "#c84a3a" },
};

const patchInk = { added: "#3f6427", removed: "#c84a3a", hunk: "#4f8fbd", plain: "#46301d" } as const;
const patchFill = { added: "#b4cb7c59", removed: "#c84a3a1a", hunk: undefined, plain: undefined } as const;

export function Patch(props: { text: string }) {
  return (
    <div class="mx-2 mb-2 max-h-80 overflow-auto bg-cream-50 py-1">
      <For each={patchLines(props.text)} keyed={false}>
        {(line) => (
          <div
            class="px-2 font-mono text-[12.5px] leading-[1.4] whitespace-pre"
            style={{ background: patchFill[patchMarkOf(line())], color: patchInk[patchMarkOf(line())] }}
          >
            {line() || " "}
          </div>
        )}
      </For>
    </div>
  );
}

export function FileRow(props: { file: ChangedFile; conflict: boolean }) {
  const [open, setOpen] = createSignal(false);
  const kind = () => changeKind(props.file.status);
  const look = () => fileLook[props.file.status] ?? { fill: "#e2c995", ink: "#46301d" };
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
        <span title={kind().label} class="flex h-5 w-5 shrink-0 items-center justify-center text-[12px]" style={{ background: look().fill, color: look().ink }}>
          {kind().mark}
        </span>
        <span title={props.file.path} class={["min-w-0 flex-1 truncate font-mono text-[12.5px]", props.conflict ? "text-berry" : "text-bark-800"]}>
          {props.file.path}
        </span>
        <Show when={props.conflict}>
          <FarmTag text={t("web.farm.conflictTag")} fill={tint("#c84a3a", 0.15)} ink="#c84a3a" />
        </Show>
        <Show when={props.file.added >= 0} fallback={<span class="font-mono text-[12.5px] text-bark-500">{t("web.farm.binary")}</span>}>
          <PlusMinus added={Math.round(props.file.added)} removed={Math.round(props.file.removed)} />
        </Show>
      </button>
      <Show when={open() && props.file.patch}>{(patch) => <Patch text={patch()} />}</Show>
    </div>
  );
}
