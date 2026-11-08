import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { ChangedFile } from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { changeKind, patchLines, patchMarkOf } from "#/features/issue/index.ts";
import { SpriteIcon } from "#/ui/pixel/index.ts";

const viewStyles = stylex.create({
  farmTagSpan: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--spacing)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "12px",
    whiteSpace: "nowrap",
  },
  farmEmptyDiv: {
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 8)",
    textAlign: "center",
    fontSize: "13px",
    color: "var(--color-bark-600)",
  },
  plusMinusSpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    whiteSpace: "nowrap",
  },
  plusMinusSpan2: {
    color: "var(--color-leaf-700)",
  },
  plusMinusSpan3: {
    color: "var(--wb-berry)",
  },
  patchDiv: {
    marginInline: "calc(var(--spacing) * 2)",
    marginBottom: "calc(var(--spacing) * 2)",
    maxHeight: "calc(var(--spacing) * 80)",
    overflow: "auto",
    backgroundColor: "var(--color-cream-50)",
    paddingBlock: "var(--spacing)",
  },
  patchDiv2: {
    paddingInline: "calc(var(--spacing) * 2)",
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    lineHeight: "1.4",
    whiteSpace: "pre",
  },
  fileRowDiv: {
    backgroundColor: "var(--color-cream-100)",
  },
  fileRowSpan: {
    display: "flex",
    height: "calc(var(--spacing) * 5)",
    width: "calc(var(--spacing) * 5)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "12px",
  },
  fileRowSpan2: {
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    color: "var(--color-bark-500)",
  },
});

/** A colour at `alpha` of its strength over cream. */
export const tint = (hex: string, alpha: number) => `color-mix(in srgb, ${hex} ${Math.round(alpha * 100)}%, #f7e8c4)`;

export function FarmTag(props: { text: string; fill?: string; ink?: string; icon?: string; goes?: boolean }) {
  return (
    <span {...stylex.attrs(viewStyles.farmTagSpan)} style={{ background: props.fill ?? "#e2c995", color: props.ink ?? "#46301d" }}>
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
  return <div {...stylex.attrs(viewStyles.farmEmptyDiv)}>{props.text}</div>;
}

/** What the server answered, under the button that asked. */

/** Hours and minutes of a time. */
export { farmClock as clockOf } from "#/farm/store.ts";

export function PlusMinus(props: { added: number; removed: number }) {
  return (
    <span {...stylex.attrs(viewStyles.plusMinusSpan)}>
      <span {...stylex.attrs(viewStyles.plusMinusSpan2)}>+{props.added}</span>
      <span {...stylex.attrs(viewStyles.plusMinusSpan3)}> −{props.removed}</span>
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

function Patch(props: { text: string }) {
  return (
    <div {...stylex.attrs(viewStyles.patchDiv)}>
      <For each={patchLines(props.text)} keyed={false}>
        {(line) => (
          <div {...stylex.attrs(viewStyles.patchDiv2)} style={{ background: patchFill[patchMarkOf(line())], color: patchInk[patchMarkOf(line())] }}>
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
    <div {...stylex.attrs(viewStyles.fileRowDiv)}>
      <button
        type="button"
        aria-label={props.file.path}
        aria-expanded={props.file.patch ? aria(open()) : undefined}
        disabled={!props.file.patch}
        onClick={() => setOpen(!open())}
        class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left enabled:cursor-pointer enabled:hover:bg-cream-200"
      >
        <span title={kind().label} {...stylex.attrs(viewStyles.fileRowSpan)} style={{ background: look().fill, color: look().ink }}>
          {kind().mark}
        </span>
        <span title={props.file.path} class={["min-w-0 flex-1 truncate font-mono text-[12.5px]", props.conflict ? "text-berry" : "text-bark-800"]}>
          {props.file.path}
        </span>
        <Show when={props.conflict}>
          <FarmTag text={t("web.farm.conflictTag")} fill={tint("#c84a3a", 0.15)} ink="#c84a3a" />
        </Show>
        <Show when={props.file.added >= 0} fallback={<span {...stylex.attrs(viewStyles.fileRowSpan2)}>{t("web.farm.binary")}</span>}>
          <PlusMinus added={Math.round(props.file.added)} removed={Math.round(props.file.removed)} />
        </Show>
      </button>
      <Show when={open() && props.file.patch}>{(patch) => <Patch text={patch()} />}</Show>
    </div>
  );
}
