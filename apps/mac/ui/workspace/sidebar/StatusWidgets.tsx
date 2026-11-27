import { Image, signal, Text, View } from "nsh";
import { Button } from "nsh/base";

import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { motionClass, motionOff } from "../../design/motion";
import { Bubble } from "../../design/Tip";
import { mix } from "../../design/tone";
import { useInterval } from "../../infra/base/timer";
import type { ActivitySummary, RailRunningState } from "./model";

export function TabIconStatus(props: {
  tabId: number;
  logoSrc?: string | undefined;
  fallbackIcon: IconName;
  iconTone: string;
  state: RailRunningState;
  attention: boolean;
  sweepPhase: boolean;
}) {
  return (
    <View class="relative size-4 shrink-0 items-center justify-center">
      <If when={props.logoSrc} else={<Icon name={props.fallbackIcon} size={14} tone={props.iconTone} />}>
        {(src) => <Image src={src()} class="size-4 object-contain" />}
      </If>
      <If when={props.state === "working"}>
        <View
          testID={`sidebar-tab-working-${props.tabId}`}
          class="pointer-events-none absolute -bottom-1 left-0 h-0.5 w-4 overflow-hidden rounded-full"
          style={{ backgroundColor: mix("leaf", 0.24) }}
        >
          <If
            when={motionOff()}
            else={
              <View
                class={`h-full w-2 rounded-full bg-leaf ${motionClass("transition-transform duration-280 ease-in-out")}`}
                style={{ transform: [{ translateX: props.sweepPhase ? 8 : 0 }] }}
              />
            }
          >
            <View class="h-full w-full rounded-full bg-leaf" />
          </If>
        </View>
      </If>
      <If
        when={props.attention}
        else={
          <If when={props.state === "ready"}>
            <View
              testID={`sidebar-tab-ready-${props.tabId}`}
              class="pointer-events-none absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full border bg-side"
              style={{ borderColor: mix("leaf", 0.72) }}
            />
          </If>
        }
      >
        <View
          testID={`sidebar-tab-attention-${props.tabId}`}
          class={`pointer-events-none absolute -right-0.5 ${props.state === "working" ? "-top-0.5" : "-bottom-0.5"} size-1.5 rounded-full bg-wheat`}
        />
      </If>
    </View>
  );
}

export function StatusDots(props: { state: RailRunningState; attention?: boolean; readyRing?: boolean }) {
  const showWorking = () => props.state === "working";
  const showReady = () => props.state === "ready" && props.readyRing !== false;
  const showAttention = () => Boolean(props.attention);
  return (
    <View class="shrink-0 flex-row items-center gap-1">
      <If when={showWorking()}>
        <View class="size-1.5 rounded-full bg-leaf" />
      </If>
      <If when={showReady()}>
        <View class="size-1.5 rounded-full border" style={{ borderColor: mix("leaf", 0.62) }} />
      </If>
      <If when={showAttention()}>
        <View class="size-1.5 rounded-full bg-wheat" />
      </If>
    </View>
  );
}

export function CollapsedSummary(props: { summary: ActivitySummary; testID?: string }) {
  const s = () => props.summary;
  const hasAny = () => s().tabs > 0 || s().working > 0 || s().ready > 0 || s().attention > 0;
  return (
    <If when={hasAny()}>
      <View testID={props.testID} class="h-4.5 shrink-0 flex-row items-center gap-1 rounded-full border border-line bg-page px-1.5">
        <If when={s().working > 0}>
          <View class="size-1.5 rounded-full bg-leaf" />
        </If>
        <If when={s().working === 0 && s().ready > 0}>
          <View class="size-1.5 rounded-full border" style={{ borderColor: mix("leaf", 0.62) }} />
        </If>
        <If when={s().attention > 0}>
          <View class="size-1.5 rounded-full bg-wheat" />
        </If>
        <If when={s().tabs > 0}>
          <Text class={`text-2xs font-medium tabular-nums ${s().working > 0 ? "text-leaf" : "text-muted"}`}>{String(s().tabs)}</Text>
        </If>
      </View>
    </If>
  );
}

export function SidebarHeaderButton(props: { testID?: string; icon: IconName; size?: number; label: string; tooltip?: string; onPress: () => void }) {
  const hovered = signal(false);
  return (
    <Button
      testID={props.testID}
      onPress={props.onPress}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      accessibilityLabel={props.label}
      tooltip={<Bubble text={props.tooltip ?? props.label} />}
      class={`size-5.5 shrink-0 items-center justify-center rounded-md ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-selected active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
    >
      <Icon name={props.icon} size={props.size ?? 13} tone={hovered() ? "ink" : "muted"} />
    </Button>
  );
}

export function SweepTicker(props: { onTick: () => void }) {
  useInterval(() => props.onTick(), 420);
  return null;
}
