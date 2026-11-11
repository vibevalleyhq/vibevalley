import * as stylex from "@stylexjs/stylex";
import { createSignal, For } from "solid-js";

import { t } from "@vibevalley/i18n";

import { splitChips } from "./cells";
import { SpriteIcon } from "./icons";
import { pxStyle } from "./style";

const styles = stylex.create({
  pxChipsInputButton: {
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    paddingInline: "0.25rem",
    paddingBlock: "0.125rem",
    opacity: {
      default: ".7",
      "@media (hover:hover)": {
        default: null,
        ":enabled:hover": "1",
      },
    },
    outlineStyle: {
      default: "none",
      ":focus-visible": "solid",
    },
    outlineWidth: {
      default: null,
      ":focus-visible": "2px",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "1px",
    },
    outlineColor: {
      default: null,
      ":focus-visible": "var(--color-leaf-500)",
    },
  },
  box: {
    display: "flex",
    minHeight: "2.25rem",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.25rem",
    backgroundColor: "var(--color-cream-100)",
    padding: "0.375rem",
  },
  disabled: {
    opacity: ".5",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    backgroundColor: "var(--color-cream-300)",
    paddingBlock: "0.125rem",
    paddingRight: "0.25rem",
    paddingLeft: "0.5rem",
    color: "var(--color-bark-800)",
  },
  input: {
    height: "1.5rem",
    backgroundColor: "transparent",
    paddingInline: "0.25rem",
    color: {
      default: "var(--color-bark-900)",
      "::placeholder": "var(--color-bark-500)",
    },
    caretColor: "var(--color-bark-900)",
    outlineStyle: "none",
  },
  inputAfterChips: {
    width: "6rem",
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
    <div {...stylex.attrs(pxStyle.ring, styles.box, props.disabled === true && styles.disabled)}>
      <For each={props.value}>
        {(chip) => (
          <span {...stylex.attrs(pxStyle.xs, styles.chip)}>
            {chip}
            <button
              type="button"
              aria-label={t("web.ui.pixel.drop", { chip })}
              disabled={props.disabled}
              onClick={() => props.onChange(props.value.filter((c) => c !== chip))}
              {...stylex.attrs(styles.pxChipsInputButton)}
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
        {...stylex.attrs(pxStyle.sm, styles.input, props.value.length === 0 ? styles.inputEmpty : styles.inputAfterChips)}
      />
    </div>
  );
}
