import { appWording } from "../app/words";
import { createSignal, For } from "solid-js";

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
    <div class={[box, { "opacity-50": !!props.disabled }]}>
      <For each={props.value}>
        {(v) => (
          <span class="flex items-center gap-0.5 rounded bg-hover py-px pr-0.5 pl-1.5 text-xs">
            {v}
            <button
              type="button"
              disabled={props.disabled}
              aria-label={appWording().chips.drop(v)}
              onClick={() => props.onChange(props.value.filter((x) => x !== v))}
              class="cursor-pointer rounded px-1 text-muted hover:bg-selected hover:text-berry"
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
        class="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-faint"
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
    <div class={["flex flex-col gap-1.5", { "opacity-50": !!props.disabled }]}>
      {/* By name: a keystroke makes new pairs, and a row made again would lose its input's focus. */}
      <For each={rows()} keyed={([k]) => k}>
        {(row) => {
          const k = () => row()[0];
          return (
            <div class="flex items-center gap-1.5">
              <span class="w-40 truncate font-mono text-sm">{k()}</span>
              <input
                aria-label={appWording().chips.valueOf(k())}
                disabled={props.disabled}
                class={[field, "flex-1"]}
                value={row()[1]}
                onInput={(e) => props.onChange({ ...props.value, [k()]: e.currentTarget.value })}
              />
              <button
                type="button"
                disabled={props.disabled}
                aria-label={appWording().chips.removeKey(k())}
                onClick={() => props.onChange(Object.fromEntries(rows().filter(([x]) => x !== k())))}
                class="cursor-pointer rounded px-1.5 text-xs text-muted hover:text-berry"
              >
                {appWording().chips.remove}
              </button>
            </div>
          );
        }}
      </For>
      <form
        class="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!key().trim()) return;
          props.onChange({ ...props.value, [key().trim()]: val() });
          setKey("");
          setVal("");
        }}
      >
        <input
          aria-label={appWording().chips.name}
          disabled={props.disabled}
          placeholder="NAME"
          class={[field, "w-40"]}
          value={key()}
          onInput={(e) => setKey(e.currentTarget.value)}
        />
        <input
          aria-label={appWording().chips.value}
          disabled={props.disabled}
          placeholder={appWording().chips.valueHint}
          class={[field, "flex-1"]}
          value={val()}
          onInput={(e) => setVal(e.currentTarget.value)}
        />
        <button
          type="submit"
          disabled={props.disabled || !key().trim()}
          class="h-7 cursor-pointer rounded-md border border-line px-2.5 text-sm hover:bg-hover disabled:opacity-50"
        >
          {appWording().chips.add}
        </button>
      </form>
    </div>
  );
}
