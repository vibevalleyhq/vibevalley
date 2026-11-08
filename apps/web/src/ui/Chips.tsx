import * as stylex from "@stylexjs/stylex";
import { createSignal, For } from "solid-js";

import { t } from "@vibevalley/i18n";

const viewStyles = stylex.create({
  chipsInputSpan: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * .5)",
    borderRadius: ".25rem",
    backgroundColor: "var(--wb-hover)",
    paddingBlock: "1px",
    paddingRight: "calc(var(--spacing) * .5)",
    paddingLeft: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  chipsInputButton: {
    cursor: "pointer",
    borderRadius: ".25rem",
    paddingInline: "var(--spacing)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-berry)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-selected)",
      },
    },
  },
  chipsInputInput: {
    height: "calc(var(--spacing) * 6)",
    minWidth: "calc(var(--spacing) * 24)",
    flex: "1",
    backgroundColor: "transparent",
    paddingInline: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    outlineStyle: "none",
    color: {
      default: null,
      "::placeholder": "var(--wb-faint)",
    },
  },
  keyValueEditorDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  keyValueEditorSpan: {
    width: "calc(var(--spacing) * 40)",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  keyValueEditorButton: {
    cursor: "pointer",
    borderRadius: ".25rem",
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-berry)",
      },
    },
  },
  newPairAdd: {
    height: "calc(var(--spacing) * 7)",
    cursor: "pointer",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
});

const box = "flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md border border-line bg-page px-1.5 py-1 focus-within:border-focus";

/** Words as chips: enter (or a comma) adds the typed one, backspace on an empty box takes the last off. */
export function ChipsInput(props: { value: readonly string[]; onChange: (v: string[]) => void; placeholder?: string; label: string; disabled?: boolean }) {
  const [text, setText] = createSignal("");
  const add = () => {
    const t = text().trim();
    if (t && !props.value.includes(t)) props.onChange([...props.value, t]);
    setText("");
  };
  return (
    <div class={[box, { "opacity-50": !(props.disabled !== true) }]}>
      <For each={props.value}>
        {(v) => (
          <span {...stylex.attrs(viewStyles.chipsInputSpan)}>
            {v}
            <button
              type="button"
              disabled={props.disabled}
              aria-label={t("web.base.chips.drop", { v })}
              onClick={() => props.onChange(props.value.filter((x) => x !== v))}
              {...stylex.attrs(viewStyles.chipsInputButton)}
            >
              ×
            </button>
          </span>
        )}
      </For>
      <input
        aria-label={props.label}
        disabled={props.disabled}
        value={text()}
        placeholder={props.value.length === 0 ? props.placeholder : undefined}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.isComposing) return;
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && text() === "" && props.value.length > 0) props.onChange(props.value.slice(0, -1));
        }}
        {...stylex.attrs(viewStyles.chipsInputInput)}
      />
    </div>
  );
}

/** Names and their values, a row each, and an empty row to add one. */
export function KeyValueEditor(props: { value: Readonly<Record<string, string>>; onChange: (v: Record<string, string>) => void; disabled?: boolean }) {
  const [key, setKey] = createSignal("");
  const [val, setVal] = createSignal("");
  const rows = () => Object.entries(props.value);
  const field = "h-8 min-w-0 rounded-md border border-line bg-page px-2 font-mono text-sm outline-none placeholder:text-faint focus:border-focus";
  return (
    <div class={["flex flex-col gap-1.5", { "opacity-50": !(props.disabled !== true) }]}>
      {/* By name: a keystroke makes new pairs, and a row made again would lose its input's focus. */}
      <For each={rows()} keyed={([k]) => k}>
        {(row) => {
          const k = () => row()[0];
          return (
            <div {...stylex.attrs(viewStyles.keyValueEditorDiv)}>
              <span {...stylex.attrs(viewStyles.keyValueEditorSpan)}>{k()}</span>
              <input
                data-testid="pair-value"
                data-key={k()}
                aria-label={t("web.base.chips.valueOf", { k: k() })}
                disabled={props.disabled}
                class={[field, "flex-1"]}
                value={row()[1]}
                onInput={(e) => props.onChange({ ...props.value, [k()]: e.currentTarget.value })}
              />
              <button
                type="button"
                disabled={props.disabled}
                aria-label={t("web.base.chips.removeKey", { k: k() })}
                onClick={() => props.onChange(Object.fromEntries(rows().filter(([x]) => x !== k())))}
                {...stylex.attrs(viewStyles.keyValueEditorButton)}
              >
                {t("web.base.chips.remove")}
              </button>
            </div>
          );
        }}
      </For>
      <form
        {...stylex.attrs(viewStyles.keyValueEditorDiv)}
        onSubmit={(e) => {
          e.preventDefault();
          if (!key().trim()) return;
          props.onChange({ ...props.value, [key().trim()]: val() });
          setKey("");
          setVal("");
        }}
      >
        <input
          data-testid="new-pair-name"
          aria-label={t("web.base.chips.name")}
          disabled={props.disabled}
          placeholder="NAME"
          class={[field, "w-40"]}
          value={key()}
          onInput={(e) => setKey(e.currentTarget.value)}
        />
        <input
          data-testid="new-pair-value"
          aria-label={t("web.base.chips.value")}
          disabled={props.disabled}
          placeholder={t("web.base.chips.valueHint")}
          class={[field, "flex-1"]}
          value={val()}
          onInput={(e) => setVal(e.currentTarget.value)}
        />
        <button type="submit" data-testid="new-pair-add" disabled={props.disabled === true || key().trim() === ""} {...stylex.attrs(viewStyles.newPairAdd)}>
          {t("web.base.chips.add")}
        </button>
      </form>
    </div>
  );
}
