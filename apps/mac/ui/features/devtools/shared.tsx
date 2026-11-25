import { Clipboard, Scroll, signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";

import { IconButton } from "../../design/IconButton";
import { CountPill } from "../../design/Tag";
import { useTimeout } from "../../infra/base/timer";

export function CopyButton(props: { text: string; testID?: string | undefined }) {
  const copied = signal(false);
  const schedule = useTimeout();
  const copy = () => {
    void Clipboard.writeText(props.text).then(
      () => {
        copied.set(true);
        schedule(() => copied.set(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <IconButton
      icon={copied() ? "check" : "copy"}
      size={14}
      label={copied() ? t("web.devtools.actions.copied") : t("web.devtools.actions.copy")}
      testid={props.testID}
      onClick={copy}
    />
  );
}

export function SectionHeader(props: { title: string; count?: number | undefined; action?: JSX.Element | undefined }) {
  return (
    <View class="flex-row items-center justify-between gap-2">
      <View class="min-w-0 flex-row items-center gap-1.5">
        <Text role="header" class="truncate text-xs font-semibold text-muted">
          {props.title}
        </Text>
        <If when={props.count !== undefined}>
          <CountPill count={props.count ?? 0} />
        </If>
      </View>
      {props.action}
    </View>
  );
}

export function MetricTile(props: { label: string; value: string; mono?: boolean | undefined; testID?: string | undefined }) {
  return (
    <View testID={props.testID} class="min-w-36 flex-1 gap-0.5 rounded-md border border-line bg-page px-2.5 py-2">
      <Text class="truncate text-2xs font-medium text-faint">{props.label}</Text>
      <Text class={`truncate text-xs text-ink ${props.mono === false ? "" : "font-mono tabular-nums"}`}>{props.value}</Text>
    </View>
  );
}

export function JsonPreview(props: { content: string; copyTestID?: string | undefined; testID?: string | undefined }) {
  return (
    <View testID={props.testID} class="rounded-md border border-line bg-side">
      <View class="flex-row items-center justify-end border-b border-line px-2 py-1">
        <CopyButton text={props.content} testID={props.copyTestID} />
      </View>
      <Scroll class="max-h-56" contentClass="p-2.5">
        <Text class="font-mono text-2xs leading-relaxed text-ink">{props.content}</Text>
      </Scroll>
    </View>
  );
}
