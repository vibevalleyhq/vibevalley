import { effect, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Channel, CronView } from "@vibevalley/protocol";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { Empty } from "../../../design/layout";
import { api } from "../../../infra/api";
import { useNow } from "../../../infra/base/dom";
import { useCore } from "../../../infra/frame";
import { useRouter } from "../../../infra/router";
import { chatPath, sessionThreadOf } from "../model/places";
import { Dot, HelperFace, PhaseGlyph, phaseDot, phaseText } from "./presence";

/** The sessions arranged in this channel; the general holds those arranged in no channel. */
export function Sessions(props: { channel: Channel }) {
  const core = useCore();
  const router = useRouter();
  const now = useNow();
  const sessions = () => (core()?.sessions ?? []).filter((h) => (h.channel ? h.channel === props.channel.id : props.channel.default));
  return (
    <If
      when={sessions().length > 0}
      else={
        <Empty testid="tab-empty" icon="issues">
          {t("web.channel.issues.empty")}
        </Empty>
      }
    >
      <Scroll class="flex-1" contentClass="gap-2.5 p-4">
        <Each of={sessions()} key={(h) => h.id}>
          {(h) => {
            const thread = () => sessionThreadOf(core()?.chat, h());
            const meta = () => [`@${h().id}`, h().repo, h().branch].filter(Boolean).join(" · ");
            return (
              <View testID={`channel-session-${h().id}`} class="flex-row items-center gap-3 rounded-lg border border-line bg-page px-3.5 py-3 hover:bg-hover">
                <View class="relative shrink-0">
                  <HelperFace agent={h().agent} runtime={h().runtime} size={36} />
                  <View class="absolute -right-0.5 -bottom-0.5">
                    <Dot tone={phaseDot(h().phase)} size={7} />
                  </View>
                </View>
                <View class="min-w-0 flex-1 gap-1">
                  <View class="flex-row items-baseline gap-2">
                    <Text class="shrink-0 text-sm font-semibold text-ink">{h().name}</Text>
                    <Text class="min-w-0 flex-1 truncate font-mono text-xs text-muted">{meta()}</Text>
                  </View>
                  <If when={h().brief}>
                    <Text class="truncate text-sm text-ink">{h().brief}</Text>
                  </If>
                  <View class="flex-row items-center gap-1.5">
                    <PhaseGlyph phase={h().phase} size={12} />
                    <Text class="min-w-0 flex-1 truncate text-xs text-muted">{phaseText(h(), now())}</Text>
                  </View>
                </View>
                <If when={thread()}>
                  {(shown) => (
                    <Button icon="thread" class="shrink-0" onPress={() => router.navigate(chatPath(shown()))}>
                      {t("web.channel.issues.thread")}
                    </Button>
                  )}
                </If>
              </View>
            );
          }}
        </Each>
      </Scroll>
    </If>
  );
}

export function Crons(props: { channel: Channel }) {
  const core = useCore();
  const crons = () => (core()?.crons ?? []).filter((s) => s.channel === props.channel.id);
  return (
    <If
      when={crons().length > 0}
      else={
        <Empty testid="tab-empty" icon="clock">
          {t("web.channel.crons.empty")}
        </Empty>
      }
    >
      <Scroll class="flex-1" contentClass="gap-2.5 p-4">
        <Each of={crons()} key={(s) => s.id}>
          {(s) => <CronCard s={s()} />}
        </Each>
      </Scroll>
    </If>
  );
}

/** How long the first press of delete waits for the second. */
const sureMs = 4000;

function CronCard(props: { s: CronView }) {
  const deleting = signal(false);
  const act = createAct();
  const setEnabled = (enabled: boolean) => {
    const id = props.s.id;
    return act.run(() => api.cron.update({ id, enabled }));
  };
  const remove = () => {
    const id = props.s.id;
    return act.run(() => api.cron.delete({ id }));
  };
  effect(() => {
    if (!deleting()) return;
    const timer = setTimeout(() => deleting.set(false), sureMs);
    return () => clearTimeout(timer);
  });
  const meta = () =>
    [
      props.s.whenText,
      props.s.pending ? props.s.nextText : t("web.channel.crons.next", { next: props.s.nextText }),
      ...(props.s.agent ? [t("web.channel.crons.direct", { agent: props.s.agent })] : []),
      // Only an orchestrator has the cron tool, so an agent's cron is the orchestrator's.
      ...(props.s.by === "agent" ? [t("web.channel.crons.byOrchestrator")] : []),
    ].join(" · ");
  return (
    <View
      testID={`cron-${props.s.id}`}
      accessibilityLabel={t("web.channel.crons.label", { name: props.s.name })}
      class={`flex-row items-start gap-3 rounded-lg border border-line bg-page px-3.5 py-3 ${!(props.s.enabled || props.s.pending) ? "border-dashed" : ""}`}
    >
      <View class="mt-0.5 h-8 w-8 shrink-0 items-center justify-center rounded-md bg-side">
        <Icon name="clock" size={16} tone={props.s.enabled || props.s.pending ? "ink" : "muted"} />
      </View>
      <View class="min-w-0 flex-1 gap-1">
        <View class="flex-row flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <Text class="text-sm font-semibold text-ink">{props.s.name}</Text>
          <Text class="min-w-0 truncate text-xs text-muted">{meta()}</Text>
        </View>
        <Text class="text-sm text-ink">{props.s.text}</Text>
      </View>
      <If
        when={props.s.pending}
        else={
          <View class="shrink-0 flex-row items-center gap-1.5">
            <Button tone={props.s.enabled ? "primary" : "plain"} testID="cron-toggle" onPress={() => void setEnabled(!props.s.enabled)}>
              {props.s.enabled ? t("web.channel.crons.on") : t("web.channel.crons.off")}
            </Button>
            <If
              when={deleting()}
              else={
                <Button
                  icon="delete"
                  testID="delete"
                  accessibilityLabel={t("web.channel.crons.removeWhich", { name: props.s.name })}
                  onPress={() => deleting.set(true)}
                />
              }
            >
              <Button tone="danger" testID="delete-sure" onPress={() => void remove()}>
                {t("web.channel.crons.sure")}
              </Button>
            </If>
          </View>
        }
      >
        <View class="shrink-0 flex-row items-center gap-1.5">
          <Button
            tone="primary"
            icon="check"
            accessibilityLabel={t("web.channel.crons.approveWhich", { name: props.s.name })}
            onPress={() => void setEnabled(true)}
          >
            {t("web.channel.crons.approve")}
          </Button>
          <Button icon="cross" accessibilityLabel={t("web.channel.crons.refuseWhich", { name: props.s.name })} onPress={() => void remove()}>
            {t("web.channel.crons.refuse")}
          </Button>
        </View>
      </If>
    </View>
  );
}
