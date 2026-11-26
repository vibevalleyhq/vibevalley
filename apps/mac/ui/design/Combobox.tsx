import { computed, Text, View, type JSX } from "nsh";
import { Combobox as Base } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "./Icon";
import { motionClass, popupTransition } from "./motion";
import { mix } from "./tone";

export interface ComboboxOption<V extends string = string> {
  readonly value: V;
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly group?: string | undefined;
}

type ComboboxSingleProps<V extends string> = {
  multiple?: false | undefined;
  value: V;
  onChange: (v: V) => void;
  onClear?: (() => void) | undefined;
};

type ComboboxMultiProps<V extends string> = {
  multiple: true;
  value: readonly V[];
  onChange: (v: V[]) => void;
  onClear?: (() => void) | undefined;
};

type ComboboxCommonProps<V extends string> = {
  options: readonly ComboboxOption<V>[];
  label: string;
  placeholder?: string | undefined;
  emptyText?: string | undefined;
  clearable?: boolean | undefined;
  clearLabel?: string | undefined;
  disabled?: boolean | undefined;
  quiet?: boolean | undefined;
  /** control: 28px, for a toolbar row; field (default): 32px, beside inputs. */
  size?: "control" | "field" | undefined;
  /** The words' size: sm (default), or xs in a dense row. */
  text?: "sm" | "xs" | undefined;
  state?: "pending" | "failed" | undefined;
  class?: string | undefined;
  popupClass?: string | undefined;
  itemClass?: string | undefined;
  testid?: string | undefined;
  prefix?: JSX.Element | undefined;
  footer?: JSX.Element | undefined;
  renderOption?:
    | ((entry: { readonly value: string; readonly title: string; readonly disabled: boolean; readonly group?: string | undefined }) => JSX.Element)
    | undefined;
  onConfirm?: ((value: V[]) => void) | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
};

export type ComboboxProps<V extends string = string> = ComboboxCommonProps<V> & (ComboboxSingleProps<V> | ComboboxMultiProps<V>);

/** Searchable single- or multi-select combobox styled with Papertrails tokens. */
export function Combobox<V extends string = string>(props: ComboboxProps<V>) {
  const isMulti = () => props.multiple === true;
  const disabled = () => props.disabled === true;
  const optionByValue = computed(() => new Map<string, ComboboxOption<V>>(props.options.map((o) => [o.value, o])));
  const isOffered = (v: string): v is V => optionByValue().has(v);
  const isEmpty = (v: string): v is V => v === "";
  const items = computed(() =>
    props.options.map((o) => ({
      value: o.value,
      title: o.label,
      disabled: o.disabled === true,
      ...(o.group !== undefined ? { group: o.group } : {}),
    })),
  );
  const selectedValues = computed<string[]>(() => {
    if (props.multiple === true) return [...props.value];
    return props.value !== "" ? [props.value] : [];
  });
  const selectedChips = computed(() => {
    if (props.multiple !== true) return [];
    const byValue = optionByValue();
    return props.value.map((v) => ({ value: v, label: byValue.get(v)?.label ?? v }));
  });
  const textClass = () => (props.text === "xs" ? "text-xs" : "text-sm");
  const rootSurface = () => {
    if (props.state === "failed") return "border-berry bg-bad-soft";
    if (props.state === "pending") return "";
    if (props.quiet === true) {
      return disabled()
        ? "border-transparent bg-transparent"
        : "border-transparent bg-transparent hover:border-line hover:bg-page focus-within:border-focus focus-within:bg-page";
    }
    return disabled() ? "border-line bg-page" : "border-line bg-page hover:border-faint focus-within:border-focus";
  };
  const rootStyle = () => (props.state === "pending" ? { borderColor: mix("wheat", 0.55), backgroundColor: mix("wheat", 0.1) } : undefined);

  return (
    <Base
      testID={props.testid}
      inputTestID={props.testid ? `${props.testid}-input` : undefined}
      accessibilityLabel={props.label}
      multiple={isMulti()}
      items={items()}
      value={selectedValues()}
      placeholder={props.placeholder}
      cleanable={props.clearable === true}
      disabled={props.disabled}
      placement="bottom"
      align="start"
      offset={4}
      clearButtonAccessibilityLabel={props.clearLabel ?? t("web.issue.page.clear")}
      clearButtonClass="shrink-0"
      clearButton={
        <View testID={props.testid ? `${props.testid}-clear` : undefined} class="size-4 items-center justify-center rounded-xs hover:bg-hover">
          <Icon name="close" size={10} tone="muted" />
        </View>
      }
      triggerButton={
        <View testID={props.testid ? `${props.testid}-trigger` : undefined} class="size-5 shrink-0 items-center justify-center rounded-sm hover:bg-hover">
          <Icon name="choose" size={12} tone={props.state === "failed" ? "berry" : "muted"} />
        </View>
      }
      prefix={
        <If when={isMulti() && selectedChips().length > 0} else={props.prefix}>
          <View class="flex-row flex-wrap items-center gap-1">
            {props.prefix}
            <Each of={selectedChips()} key={(chip) => chip.value}>
              {(chip) => (
                <View
                  testID={props.testid ? `${props.testid}-chip-${chip().value}` : undefined}
                  class="h-6 flex-row items-center gap-1 rounded-sm bg-hover pr-0.5 pl-1.5"
                >
                  <Text class="max-w-36 truncate text-xs font-medium text-ink">{chip().label}</Text>
                  <If when={!disabled()}>
                    <View
                      role="button"
                      testID={props.testid ? `${props.testid}-chip-remove-${chip().value}` : undefined}
                      accessibilityLabel={t("web.base.chips.drop", { v: chip().label })}
                      onPress={() => {
                        if (props.multiple === true) {
                          props.onChange(props.value.filter((v) => v !== chip().value));
                        }
                      }}
                      class="size-4 items-center justify-center rounded-xs hover:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      <Icon name="close" size={10} tone="muted" />
                    </View>
                  </If>
                </View>
              )}
            </Each>
          </View>
        </If>
      }
      inputClass={`min-w-16 flex-1 bg-transparent text-ink placeholder:text-faint ${textClass()} ${isMulti() ? "h-6 px-1" : ""}`}
      class={[
        "min-w-0 flex-row rounded-md border",
        isMulti()
          ? "min-h-8 flex-wrap items-center gap-1 px-1.5 py-1"
          : props.size === "control"
            ? "h-7 items-center gap-1.5 px-2"
            : "h-8 items-center gap-1.5 px-2.5",
        rootSurface(),
        disabled() ? "opacity-50" : "",
        props.class ?? "",
      ].join(" ")}
      style={rootStyle()}
      popupClass={`min-w-44 max-h-72 rounded-lg border border-line-strong bg-elevated p-1 shadow-float ${motionClass("transition-opacity duration-120 ease-out")} ${props.popupClass ?? ""}`}
      popupStartingClass={popupTransition("opacity-0")}
      popupEndingClass={popupTransition("opacity-0")}
      listClass="max-h-64 gap-0.5"
      groupClass="px-2 pt-1.5 pb-0.5 text-2xs font-semibold text-faint"
      footerClass="mt-1 border-t border-line pt-1"
      itemClass={
        props.itemClass ??
        "group min-h-7 flex-row items-center gap-2 rounded-md px-2 py-1 focus:bg-hover hover:bg-hover selected:bg-selected disabled:opacity-50"
      }
      footer={props.footer}
      empty={
        <View class="items-center px-2 py-3">
          <Text class="text-xs text-muted">{props.emptyText ?? t("web.base.table.empty")}</Text>
        </View>
      }
      renderItem={(entry) => (
        <View class="min-w-0 flex-1 flex-row items-center gap-2">
          <If
            when={props.renderOption !== undefined}
            else={<Text class={`min-w-0 flex-1 truncate ${textClass()} text-ink group-selected:font-medium group-disabled:text-faint`}>{entry.title}</Text>}
          >
            <View class="min-w-0 flex-1">
              {props.renderOption?.({ value: entry.value, title: entry.title, disabled: entry.disabled, group: entry.group ?? undefined })}
            </View>
          </If>
          <View class="size-3.5 shrink-0 items-center justify-center opacity-0 group-selected:opacity-100">
            <Icon name="ticked" size={12} tone="accent" />
          </View>
        </View>
      )}
      onChange={(e) => {
        if (props.multiple === true) {
          props.onChange(e.value.filter(isOffered));
          return;
        }
        const first = e.value[0];
        if (first === undefined) {
          if (props.onClear) {
            props.onClear();
          } else {
            const blank: string = "";
            if (isEmpty(blank)) props.onChange(blank);
          }
          return;
        }
        if (isOffered(first)) props.onChange(first);
      }}
      onConfirm={props.onConfirm ? (e) => props.onConfirm?.(e.value.filter(isOffered)) : undefined}
      onOpenChange={props.onOpenChange ? (e) => props.onOpenChange?.(e.open) : undefined}
    />
  );
}
