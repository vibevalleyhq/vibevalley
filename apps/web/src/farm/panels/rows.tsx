import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { ChangedFile } from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { changeKind, patchLines, patchMarkOf } from "#/features/issue/index.ts";
import { SpriteIcon } from "#/ui/pixel/index.ts";
import { styleProps } from "#/ui/positioner.ts";

const styles = stylex.create({
  fileRowButton: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    textAlign: "left",
    cursor: {
      default: null,
      ":enabled": "pointer",
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":enabled:hover": "var(--color-cream-200)",
      },
    },
  },
  filePath: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
  },
  filePathConflict: {
    color: "var(--color-berry)",
  },
  filePathNormal: {
    color: "var(--color-bark-800)",
  },
  tinted: {
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  farmTag: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--spacing)",
    backgroundColor: "var(--color-cream-200)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "12px",
    whiteSpace: "nowrap",
    color: "var(--color-bark-800)",
  },
  conflictTag: {
    backgroundColor: "color-mix(in srgb, var(--color-berry-500) 15%, var(--color-cream-50))",
    color: "var(--color-berry-500)",
  },
  farmEmpty: {
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 8)",
    textAlign: "center",
    fontSize: "13px",
    color: "var(--color-bark-600)",
  },
  plusMinus: {
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    whiteSpace: "nowrap",
  },
  addedCount: {
    color: "var(--color-leaf-700)",
  },
  removedCount: {
    color: "var(--color-berry)",
  },
  patchBox: {
    marginInline: "calc(var(--spacing) * 2)",
    marginBottom: "calc(var(--spacing) * 2)",
    maxHeight: "calc(var(--spacing) * 80)",
    overflow: "auto",
    backgroundColor: "var(--color-cream-50)",
    paddingBlock: "var(--spacing)",
  },
  patchLine: {
    paddingInline: "calc(var(--spacing) * 2)",
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    lineHeight: "1.4",
    whiteSpace: "pre",
  },
  patchAdded: {
    backgroundColor: "var(--color-patch-add-bg)",
    color: "var(--color-leaf-700)",
  },
  patchRemoved: {
    backgroundColor: "var(--color-patch-del-bg)",
    color: "var(--color-berry-500)",
  },
  patchHunk: {
    color: "var(--color-water-500)",
  },
  patchPlain: {
    color: "var(--color-bark-800)",
  },
  fileRow: {
    backgroundColor: "var(--color-cream-100)",
  },
  fileBadge: {
    display: "flex",
    height: "calc(var(--spacing) * 5)",
    width: "calc(var(--spacing) * 5)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "12px",
  },
  fileBadgeAdded: {
    backgroundColor: "var(--color-diff-add-fill)",
    color: "var(--color-leaf-700)",
  },
  fileBadgeModified: {
    backgroundColor: "var(--color-diff-mod-fill)",
    color: "var(--color-bark-800)",
  },
  fileBadgeDeleted: {
    backgroundColor: "var(--color-diff-del-fill)",
    color: "var(--color-berry-500)",
  },
  fileBadgeOther: {
    backgroundColor: "var(--color-cream-200)",
    color: "var(--color-bark-800)",
  },
  binaryLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    color: "var(--color-bark-500)",
  },
});

export function FarmTag(props: { text: string; styles?: stylex.StyleXStyles; icon?: string; goes?: boolean }) {
  return (
    <span {...styleProps([styles.farmTag, props.styles])}>
      <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={12} />}</Show>
      {props.text}
      <Show when={props.goes}>
        <SpriteIcon name="button-next" size={10} />
      </Show>
    </span>
  );
}

export function Tinted(props: { children: JSX.Element; styles?: stylex.StyleXStyles; style?: JSX.CSSProperties }) {
  return <div {...styleProps([styles.tinted, props.styles], props.style)}>{props.children}</div>;
}

export function FarmEmpty(props: { text: string }) {
  return <div {...stylex.attrs(styles.farmEmpty)}>{props.text}</div>;
}

/** Hours and minutes of a time. */
export { farmClock as clockOf } from "#/farm/store.ts";

export function PlusMinus(props: { added: number; removed: number }) {
  return (
    <span {...stylex.attrs(styles.plusMinus)}>
      <span {...stylex.attrs(styles.addedCount)}>+{props.added}</span>
      <span {...stylex.attrs(styles.removedCount)}> −{props.removed}</span>
    </span>
  );
}

const fileLook: Record<string, stylex.StyleXStyles> = {
  A: styles.fileBadgeAdded,
  M: styles.fileBadgeModified,
  D: styles.fileBadgeDeleted,
};

const patchLook = {
  added: styles.patchAdded,
  removed: styles.patchRemoved,
  hunk: styles.patchHunk,
  plain: styles.patchPlain,
} as const;

function Patch(props: { text: string }) {
  return (
    <div {...stylex.attrs(styles.patchBox)}>
      <For each={patchLines(props.text)} keyed={false}>
        {(line) => <div {...stylex.attrs(styles.patchLine, patchLook[patchMarkOf(line())])}>{line() || " "}</div>}
      </For>
    </div>
  );
}

export function FileRow(props: { file: ChangedFile; conflict: boolean }) {
  const [open, setOpen] = createSignal(false);
  const kind = () => changeKind(props.file.status);
  return (
    <div {...stylex.attrs(styles.fileRow)}>
      <button
        type="button"
        aria-label={props.file.path}
        aria-expanded={props.file.patch ? aria(open()) : undefined}
        disabled={!props.file.patch}
        onClick={() => setOpen(!open())}
        {...stylex.attrs(styles.fileRowButton)}
      >
        <span title={kind().label} {...styleProps([styles.fileBadge, fileLook[props.file.status] ?? styles.fileBadgeOther])}>
          {kind().mark}
        </span>
        <span title={props.file.path} {...stylex.attrs(styles.filePath, props.conflict ? styles.filePathConflict : styles.filePathNormal)}>
          {props.file.path}
        </span>
        <Show when={props.conflict}>
          <FarmTag text={t("web.farm.conflictTag")} styles={styles.conflictTag} />
        </Show>
        <Show when={props.file.added >= 0} fallback={<span {...stylex.attrs(styles.binaryLabel)}>{t("web.farm.binary")}</span>}>
          <PlusMinus added={Math.round(props.file.added)} removed={Math.round(props.file.removed)} />
        </Show>
      </button>
      <Show when={open() && props.file.patch}>{(patch) => <Patch text={patch()} />}</Show>
    </div>
  );
}
