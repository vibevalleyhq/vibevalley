import { effect, keymap, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "./Button";
import type { IconName } from "./icons";
import { Bubble } from "./Tip";
import { mix } from "./tone";

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
  effect(() => {
    if (armed()) return keymap.bind("escape", () => armed.set(false));
  });
  return (
    <If
      when={armed()}
      else={
        <Button
          tone={props.tone === "danger" ? "danger" : "plain"}
          icon={props.icon}
          accessibilityLabel={props.title}
          tooltip={<If when={props.title}>{(title) => <Bubble text={title()} />}</If>}
          disabled={props.disabled}
          testID={props.testid}
          onPress={() => armed.set(true)}
        >
          {props.label}
        </Button>
      }
    >
      <View
        role="group"
        class={`flex-row flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 ${primary() ? "bg-ok-soft" : "bg-bad-soft"}`}
        style={{ borderColor: mix(primary() ? "accent" : "berry", 0.3) }}
      >
        <If when={props.question}>
          <Text class={`text-sm font-medium ${primary() ? "text-ok-ink" : "text-berry"}`}>{props.question}</Text>
        </If>
        <Button
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
        <Button tone="quiet" onPress={() => armed.set(false)}>
          {t("web.base.form.never")}
        </Button>
      </View>
    </If>
  );
}
