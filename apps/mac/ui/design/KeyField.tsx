import { Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { KeySource, KeyStatus } from "@vibevalley/protocol";

import { Button } from "./Button";
import { Icon } from "./Icon";
import { IconButton, OutLink } from "./IconButton";
import { Hint, Tip } from "./Tip";

const fromText = (s: KeySource) => t(`web.base.form.from.${s}`);

/** In use (and from where), not set, or to be removed on save. */
export function KeyMark(props: { status: KeyStatus; removing?: boolean }) {
  const text = () =>
    props.removing === true
      ? t("web.base.form.removeOnSave")
      : props.status.source
        ? props.status.hint
          ? t("web.base.form.inUse", { hint: props.status.hint, from: fromText(props.status.source) })
          : t("web.base.form.fromOnly", { from: fromText(props.status.source) })
        : t("web.base.form.unset");
  return (
    <Tip text={text()}>
      <View
        accessible
        focusable
        role="image"
        testID={`key-mark-${props.removing === true ? "removing" : (props.status.source ?? "unset")}`}
        accessibilityLabel={text()}
        class="shrink-0 flex-row items-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
      >
        {/* Said, not only drawn: a hollow dot did not read as "none saved". The key itself shows as its last four. */}
        <If when={props.removing === true || props.status.source !== null} else={<Text class="text-2xs text-faint">{t("web.base.form.unset")}</Text>}>
          {/* Berry and leaf: Icon's own colours for these two marks. */}
          <Icon name={props.removing === true ? "cross" : "check"} size={12} />
          <If when={props.removing !== true && props.status.hint}>
            <Text class="font-mono text-2xs text-muted tabular-nums">{props.status.hint}</Text>
          </If>
        </If>
      </View>
    </Tip>
  );
}

export function KeyField(props: {
  label: string;
  status: KeyStatus;
  removing: boolean;
  /** Marks the key for removal, or takes the mark back. */
  onRemove: (removing: boolean) => void;
  /** Where the key is made. */
  link?: { readonly href: string; readonly label: string } | undefined;
  tip?: string;
  /** A label as small as the fields' around it in a dense form. */
  small?: boolean;
  children: JSX.Element;
}) {
  return (
    <View class="gap-1.5">
      <View class="min-h-4 flex-row items-center gap-1.5">
        <Text class={`min-w-0 truncate ${props.small === true ? "text-xs font-medium text-muted" : "text-sm font-semibold text-ink"}`}>{props.label}</Text>
        <KeyMark status={props.status} removing={props.removing} />
        <If when={props.tip}>{(tip) => <Hint text={tip()} />}</If>
        <View class="flex-1" />
        <If when={props.link}>{(l) => <OutLink href={l().href} label={l().label} />}</If>
      </View>
      <View class="flex-row items-center gap-1.5">
        <View class="min-w-0 flex-1" style={{ opacity: props.removing ? 0.5 : 1, pointerEvents: props.removing ? "none" : "auto" }}>
          {props.children}
        </View>
        <If when={props.status.source === "settings"}>
          <IconButton
            icon={props.removing ? "undo" : "delete"}
            tone={props.removing ? undefined : "danger"}
            label={props.removing ? t("web.base.form.keepKey", { label: props.label }) : t("web.base.form.removeKey", { label: props.label })}
            onClick={() => props.onRemove(!props.removing)}
          />
        </If>
      </View>
    </View>
  );
}

/** Save and undo, shown while there is something to save; `left` says what went wrong. */
export function SaveBar(props: { dirty: boolean; busy: boolean; onSave: () => void; onUndo: () => void; left?: JSX.Element; extra?: JSX.Element }) {
  return (
    <View testID={props.dirty ? "save-bar-dirty" : "save-bar"} class="min-h-12 flex-row items-center gap-2 border-t border-line bg-page py-2.5">
      <View class="min-w-0 flex-1">{props.left}</View>
      {props.extra}
      <If when={props.dirty}>
        <Button tone="quiet" icon="undo" testID="undo" onPress={() => props.onUndo()}>
          {t("web.base.form.undo")}
        </Button>
      </If>
      <Button tone="primary" testID="save" disabled={!props.dirty || props.busy} onPress={() => props.onSave()}>
        {t("web.base.form.save")}
      </Button>
    </View>
  );
}
