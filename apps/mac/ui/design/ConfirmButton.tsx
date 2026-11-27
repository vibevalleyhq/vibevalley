import { effect, keymap, signal, Text, View } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Button } from "./Button";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { motionClass } from "./motion";
import { Bubble } from "./Tip";
import { mix, tone as toneColor } from "./tone";

export function ConfirmButton(props: {
  label: string;
  question?: string;
  confirm?: string;
  tone?: "danger" | "primary";
  icon?: IconName;
  title?: string;
  disabled?: boolean;
  /** The first press's test id; the confirming one's is it with -sure. */
  testid?: string;
  onConfirm: () => unknown;
}) {
  const armed = signal(false);
  const primary = () => props.tone === "primary";
  const danger = () => props.tone === "danger";
  const disabled = () => props.disabled === true;
  effect(() => {
    if (armed()) return keymap.bind("escape", () => armed.set(false));
  });
  return (
    <Popover
      open={armed()}
      onOpenChange={(e) => {
        if (!disabled()) armed.set(e.open);
      }}
      placement="bottom"
      align="end"
      offset={6}
      popupClass="max-w-80 rounded-lg border bg-elevated px-3 py-2 shadow-float"
      popupStyle={{ borderColor: mix(primary() ? "accent" : "berry", 0.35) }}
      trigger={
        <View
          testID={props.testid}
          accessibilityLabel={props.title}
          tooltip={<If when={props.title}>{(title) => <Bubble text={title()} />}</If>}
          disabled={props.disabled}
          class={[
            `h-7 flex-row items-center justify-center gap-1.5 rounded-md border px-2.5 ${motionClass("transition-transform duration-120 ease-out")}`,
            danger() ? "bg-page" : "border-line bg-page",
            disabled()
              ? "opacity-50"
              : `${danger() ? "" : "hover:border-faint hover:bg-hover"} active:translate-y-px aria-expanded:border-focus focus-visible:outline-2 focus-visible:outline-focus`,
          ].join(" ")}
          style={danger() ? { borderColor: mix("berry", 0.35) } : undefined}
          hoverStyle={!disabled() && danger() ? { borderColor: toneColor("berry"), backgroundColor: toneColor("bad-soft") } : undefined}
        >
          <If when={props.icon}>{(name) => <Icon name={name()} size={14} tone={danger() ? "berry" : "ink"} />}</If>
          <Text class={`min-w-0 truncate text-sm ${danger() ? "text-berry" : "text-ink"}`}>{props.label}</Text>
        </View>
      }
    >
      <If when={armed()}>
        <View role="group" class="flex-row flex-wrap items-center gap-2">
          <If when={props.question}>
            <Text class={`text-sm font-medium ${primary() ? "text-ok-ink" : "text-berry"}`}>{props.question}</Text>
          </If>
          <Button
            size="compact"
            tone={props.tone ?? "danger"}
            disabled={props.disabled}
            testID={props.testid && `${props.testid}-sure`}
            onPress={() => {
              armed.set(false);
              void props.onConfirm();
            }}
          >
            {props.confirm ?? props.label}
          </Button>
          <Button size="compact" tone="quiet" onPress={() => armed.set(false)}>
            {t("web.base.form.never")}
          </Button>
        </View>
      </If>
    </Popover>
  );
}
