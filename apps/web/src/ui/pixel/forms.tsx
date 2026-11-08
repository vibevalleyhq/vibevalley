import * as stylex from "@stylexjs/stylex";
import { createSignal, For } from "solid-js";

import { t } from "@vibevalley/i18n";

import { splitChips } from "./cells";
import { SpriteIcon } from "./icons";
import { pxFocus, pxStyle } from "./style";

const viewStyles = stylex.create({
  box: {
    display: "flex",
    minHeight: "calc(var(--spacing) * 9)",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "var(--spacing)",
    backgroundColor: "var(--color-cream-100)",
    padding: "calc(var(--spacing) * 1.5)",
  },
  disabled: {
    opacity: ".5",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--spacing)",
    backgroundColor: "var(--color-cream-300)",
    paddingBlock: "calc(var(--spacing) * .5)",
    paddingRight: "var(--spacing)",
    paddingLeft: "calc(var(--spacing) * 2)",
    color: "var(--color-bark-800)",
  },
  input: {
    height: "calc(var(--spacing) * 6)",
    backgroundColor: "transparent",
    paddingInline: "var(--spacing)",
    color: {
      default: "var(--color-bark-900)",
      "::placeholder": "var(--color-bark-500)",
    },
    caretColor: "var(--color-bark-900)",
    outlineStyle: "none",
  },
  inputAfterChips: {
    width: "calc(var(--spacing) * 24)",
    flexGrow: "1",
  },
  inputEmpty: {
    minWidth: "0",
    flex: "1",
  },
});

/** Enter or a comma adds what is typed, and so does leaving the box; Backspace in an empty box takes the last chip off. */
export function PxChipsInput(props: {
  value: readonly string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  disabled?: boolean;
  label?: string;
  id?: string;
}) {
  const [draft, setDraft] = createSignal("");
  const add = () => {
    const parts = splitChips(draft(), props.value);
    if (parts.length > 0) props.onChange([...props.value, ...parts]);
    setDraft("");
  };
  return (
    <div {...stylex.attrs(pxStyle.ring, viewStyles.box, props.disabled === true && viewStyles.disabled)}>
      <For each={props.value}>
        {(chip) => (
          <span {...stylex.attrs(pxStyle.xs, viewStyles.chip)}>
            {chip}
            <button
              type="button"
              aria-label={t("web.ui.pixel.drop", { chip })}
              disabled={props.disabled}
              onClick={() => props.onChange(props.value.filter((c) => c !== chip))}
              class={[pxFocus, "cursor-pointer px-1 py-0.5 opacity-70 enabled:hover:opacity-100 disabled:cursor-default"]}
            >
              <SpriteIcon name="button-close" size={10} />
            </button>
          </span>
        )}
      </For>
      <input
        id={props.id}
        value={draft()}
        disabled={props.disabled}
        aria-label={props.label}
        placeholder={props.value.length === 0 ? props.placeholder : ""}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.isComposing) return;
          if (e.key === "," || e.key === "Enter") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && draft() === "" && props.value.length > 0) {
            e.preventDefault();
            props.onChange(props.value.slice(0, -1));
          }
        }}
        // The box takes the whole row while there are no chips (room for the placeholder) and 96 px after them.
        {...stylex.attrs(pxStyle.sm, viewStyles.input, props.value.length === 0 ? viewStyles.inputEmpty : viewStyles.inputAfterChips)}
      />
    </div>
  );
}
