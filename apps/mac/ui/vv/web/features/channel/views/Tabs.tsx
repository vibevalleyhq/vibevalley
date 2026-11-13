// Ported from VibeValley apps/web/src/features/channel/views/Tabs.tsx: a
// channel's issues (the sessions arranged in it) and its crons. The second
// press deletes a cron, as there; a press elsewhere does not take the first
// back (no document listener): it goes back after a few seconds.
import { effect, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Channel, CronView } from "@vibevalley/protocol";

import { useNow } from "../../../base/dom";
import { api } from "../../../infra/api";
import { useCore } from "../../../infra/frame";
import { useRouter } from "../../../infra/router";
import { createAct } from "../../../ui/act";
import { Button } from "../../../ui/Button";
import { Icon } from "../../../ui/Icon";
import { Empty } from "../../../ui/layout";
import { chatPath, sessionThreadOf } from "../model/places";
import { HelperFace, PhaseGlyph, phaseText } from "./presence";

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
      <Scroll class="flex-1" contentClass="gap-3 p-4">
        <Each of={sessions()} key={(h) => h.id}>
          {(h) => {
            const thread = () => sessionThreadOf(core()?.chat, h());
            return (
              <View testID={`channel-session-${h().id}`} class="flex-row items-center gap-3 rounded-lg border border-line bg-page p-3">
                <HelperFace agent={h().agent} runtime={h().runtime} size={36} />
                <View class="min-w-0 flex-1">
                  <Text class="truncate text-sm font-semibold text-ink">
                    {h().name}
                    <Text class="text-xs font-normal text-muted">{`  @${h().id} ${h().repo ?? ""}${h().branch ? ` · ${h().branch}` : ""}`}</Text>
                  </Text>
                  <Text class="truncate text-sm text-ink">{h().brief}</Text>
                  <View class="flex-row items-center gap-1">
                    <PhaseGlyph phase={h().phase} />
                    <Text class="truncate text-xs text-muted">{phaseText(h(), now())}</Text>
                  </View>
                </View>
                <If when={thread()}>
                  {(shown) => (
                    <Button icon="thread" onPress={() => router.navigate(chatPath(shown()))}>
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
      <Scroll class="flex-1" contentClass="gap-3 p-4">
        <Each of={crons()} key={(s) => s.id}>
          {(s) => <CronCard s={s()} />}
        </Each>
      </Scroll>
    </If>
  );
}

/** How long the first press of delete waits for the second. */
const sureMs = 4000;

export function CronCard(props: { s: CronView }) {
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
      class={`flex-row items-start gap-3 rounded-lg border border-line bg-page p-3 ${!(props.s.enabled || props.s.pending) ? "border-dashed" : ""}`}
    >
      <View class="mt-0.5">
        <Icon name="clock" size={20} />
      </View>
      <View class="min-w-0 flex-1">
        <Text class="text-sm font-semibold text-ink">
          {props.s.name}
          <Text class="text-xs font-normal text-muted">{`  ${meta()}`}</Text>
        </Text>
        <Text class="text-sm text-ink">{props.s.text}</Text>
      </View>
      <If
        when={props.s.pending}
        else={
          <View class="flex-row gap-2">
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
        <View class="flex-row gap-2">
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
