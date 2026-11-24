import { computed, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "./Icon";
import { motionClass } from "./motion";
import { Bubble } from "./Tip";

const field = "h-8 min-w-0 rounded-md border border-line bg-page px-2.5 font-mono text-sm text-ink placeholder:text-faint";

/** Words as chips: enter (or a comma) adds the typed one, backspace on an empty box takes the last off. */
export function ChipsInput(props: { value: readonly string[]; onChange: (v: string[]) => void; placeholder?: string; label: string; disabled?: boolean }) {
  const text = signal("");
  const add = (typed = text()) => {
    const word = typed.trim();
    if (word && !props.value.includes(word)) props.onChange([...props.value, word]);
    text.set("");
  };
  return (
    <View
      class={[
        "min-h-8 w-full flex-row flex-wrap items-center gap-1 rounded-md border border-line bg-page px-1.5 py-1",
        props.disabled === true ? "bg-side opacity-50" : "hover:border-faint focus-within:border-focus",
      ].join(" ")}
    >
      <Each of={props.value} key={(v) => v}>
        {(v) => (
          <View class="h-6 flex-row items-center gap-1 rounded-sm bg-hover pr-0.5 pl-1.5">
            <Text class="text-xs font-medium text-ink">{v()}</Text>
            <View
              role="button"
              disabled={props.disabled}
              accessibilityLabel={t("web.base.chips.drop", { v: v() })}
              tooltip={<Bubble text={t("web.base.chips.drop", { v: v() })} />}
              onPress={() => props.onChange(props.value.filter((x) => x !== v()))}
              class="size-4 items-center justify-center rounded-xs hover:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
            >
              <Icon name="close" size={10} tone="muted" />
            </View>
          </View>
        )}
      </Each>
      <Input
        accessibilityLabel={props.label}
        readonly={props.disabled}
        value={text()}
        placeholder={props.value.length === 0 ? props.placeholder : undefined}
        onChange={(e) => {
          if (e.value.endsWith(",") || e.value.endsWith("\uFF0C")) add(e.value.slice(0, -1));
          else text.set(e.value);
        }}
        onSubmit={() => add()}
        onBlur={() => add()}
        onKeyPress={(e) => {
          if (e.key === "Backspace" && text() === "" && props.value.length > 0) props.onChange(props.value.slice(0, -1));
        }}
        class="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm text-ink placeholder:text-faint"
      />
    </View>
  );
}

/** Names and their values, a row each, and an empty row to add one. */
export function KeyValueEditor(props: { value: Readonly<Record<string, string>>; onChange: (v: Record<string, string>) => void; disabled?: boolean }) {
  const key = signal("");
  const val = signal("");
  const rows = computed(() => Object.entries(props.value));
  const addDisabled = computed(() => props.disabled === true || key().trim() === "");
  const inputClass = () => (props.disabled === true ? `${field} bg-side` : `${field} hover:border-faint focus:border-focus`);
  const add = () => {
    if (!key().trim()) return;
    props.onChange({ ...props.value, [key().trim()]: val() });
    key.set("");
    val.set("");
  };
  return (
    <View class={`gap-1.5 ${props.disabled === true ? "opacity-50" : ""}`}>
      {/* By name: a keystroke makes new pairs, and a row made again would lose its input's focus. */}
      <Each of={rows()} key={([k]) => k}>
        {(row) => {
          const k = () => row()[0];
          return (
            <View class="flex-row items-center gap-1.5">
              <Text class="w-40 shrink-0 truncate font-mono text-sm text-ink">{k()}</Text>
              <Input
                testID={`pair-value-${k()}`}
                accessibilityLabel={t("web.base.chips.valueOf", { k: k() })}
                readonly={props.disabled}
                class={`${inputClass()} flex-1`}
                value={row()[1]}
                onChange={(e) => props.onChange({ ...props.value, [k()]: e.value })}
              />
              <View
                role="button"
                disabled={props.disabled}
                accessibilityLabel={t("web.base.chips.removeKey", { k: k() })}
                tooltip={<Bubble text={t("web.base.chips.removeKey", { k: k() })} />}
                onPress={() => props.onChange(Object.fromEntries(rows().filter(([x]) => x !== k())))}
                class={[
                  "group h-8 shrink-0 items-center justify-center rounded-md px-2",
                  props.disabled === true ? "" : "hover:bg-bad-soft focus-visible:outline-2 focus-visible:outline-focus",
                ].join(" ")}
              >
                <Text class="text-xs text-muted group-hover:text-berry">{t("web.base.chips.remove")}</Text>
              </View>
            </View>
          );
        }}
      </Each>
      <View class="flex-row items-center gap-1.5">
        <Input
          testID="new-pair-name"
          accessibilityLabel={t("web.base.chips.name")}
          readonly={props.disabled}
          placeholder="NAME"
          class={`${inputClass()} w-40 shrink-0`}
          value={key()}
          onChange={(e) => key.set(e.value)}
          onSubmit={add}
        />
        <Input
          testID="new-pair-value"
          accessibilityLabel={t("web.base.chips.value")}
          readonly={props.disabled}
          placeholder={t("web.base.chips.valueHint")}
          class={`${inputClass()} flex-1`}
          value={val()}
          onChange={(e) => val.set(e.value)}
          onSubmit={add}
        />
        <View
          role="button"
          testID="new-pair-add"
          disabled={addDisabled()}
          onPress={add}
          class={[
            `h-8 shrink-0 items-center justify-center rounded-md border border-line bg-page px-2.5 ${motionClass("transition-transform duration-120 ease-out")}`,
            addDisabled() ? "opacity-50" : "hover:border-faint hover:bg-hover active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus",
          ].join(" ")}
        >
          <Text class="text-sm text-ink">{t("web.base.chips.add")}</Text>
        </View>
      </View>
    </View>
  );
}
