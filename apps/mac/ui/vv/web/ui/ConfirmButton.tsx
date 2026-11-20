import { signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "./Button";
import type { IconName } from "./icons";

/** A button for what cannot be taken back (docs/style/design.md): the first press asks in place, the question, the action's own button and a way back. */
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
  return (
    <If
      when={armed()}
      else={
        <Button icon={props.icon} accessibilityLabel={props.title} disabled={props.disabled} testID={props.testid} onPress={() => armed.set(true)}>
          {props.label}
        </Button>
      }
    >
      <View role="group" class="flex-row flex-wrap items-center gap-2">
        <If when={props.question}>
          <Text class="text-sm text-muted">{props.question}</Text>
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
        <Button onPress={() => armed.set(false)}>{t("web.base.form.never")}</Button>
      </View>
    </If>
  );
}
