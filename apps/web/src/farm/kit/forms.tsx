import { farmWording } from "../words";
import { createSignal, For } from "solid-js";
import { splitChips } from "./chips";
import { pxRing, pxText } from "./style";
import { SpriteIcon } from "./icons";

const focusRing = "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-leaf-500 focus-visible:outline-solid";

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
    <div class={["flex min-h-9 flex-wrap items-center gap-1 bg-cream-100 p-1.5", pxRing, { "opacity-50": !!props.disabled }]}>
      <For each={props.value}>
        {(chip) => (
          <span class={[pxText.xs, "inline-flex items-center gap-1 bg-cream-300 py-0.5 pr-1 pl-2 text-bark-800"]}>
            {chip}
            <button
              type="button"
              aria-label={farmWording().drop(chip)}
              disabled={props.disabled}
              onClick={() => props.onChange(props.value.filter((c) => c !== chip))}
              class={[focusRing, "cursor-pointer px-1 py-0.5 opacity-70 enabled:hover:opacity-100 disabled:cursor-default"]}
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
        class={[
          pxText.sm,
          "h-6 bg-transparent px-1 text-bark-900 caret-bark-900 outline-none placeholder:text-bark-500",
          props.value.length === 0 ? "min-w-0 flex-1" : "w-24 grow",
        ]}
      />
    </div>
  );
}
