import { cleanup, computed, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { HostLiveVoicePhase, HostLiveVoiceState as LiveVoiceSnapshot } from "@vibevalley/protocol";
import { HostLiveVoiceState } from "@vibevalley/protocol/schema";

import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { Banner } from "../../../design/layout";
import { Dot } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { createAct } from "../../../infra/act";
import { useInterval } from "../../../infra/base/timer";
import { providerQuery, ready, useQuery } from "../../../infra/query";
import { transport } from "../../../infra/transport";
import { MossVerify } from "./MossVerify";
import { MicWaveform, VoiceOrb } from "./VoiceVisuals";

const formatElapsed = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const phaseMeta = (phase: HostLiveVoicePhase, elapsed: string) => {
  switch (phase) {
    case "idle":
      return undefined;
    case "connecting":
      return { dot: "wheat" as const, bgClass: "bg-warn-soft", textClass: "text-warn-ink", label: t("web.voice.moss.connecting"), mono: false };
    case "live":
      return { dot: "leaf" as const, bgClass: "bg-ok-soft", textClass: "text-ok-ink", label: elapsed, mono: true };
    case "stopping":
      return { dot: "wheat" as const, bgClass: "bg-warn-soft", textClass: "text-warn-ink", label: t("web.voice.moss.hangUp"), mono: false };
  }
};

function PhasePill(props: { phase: HostLiveVoicePhase; muted: boolean; elapsed: string }) {
  const meta = () => phaseMeta(props.phase, props.elapsed);
  return (
    <View class="flex-row items-center gap-1.5">
      <If when={meta()} else={<Dot tone="idle" size={7} ring={false} />}>
        {(m) => (
          <View class={`h-6 flex-row items-center gap-1.5 rounded-full px-2.5 ${m().bgClass}`}>
            <Dot tone={m().dot} size={6} ring={false} />
            <Text class={`text-xs font-medium ${m().mono ? "font-mono tabular-nums" : ""} ${m().textClass}`}>{m().label}</Text>
          </View>
        )}
      </If>
      <If when={props.phase === "live" && props.muted}>
        <View class="h-6 flex-row items-center gap-1 rounded-full bg-bad-soft px-2.5">
          <Icon name="record" size={12} tone="berry" />
          <Text class="text-xs font-medium text-berry">{t("web.voice.moss.mute")}</Text>
        </View>
      </If>
    </View>
  );
}

const initialCallState: LiveVoiceSnapshot = {
  phase: "idle",
  muted: false,
  micLevel: 0,
  problem: null,
  heard: "",
  said: "",
};

export function NativeCall() {
  const providers = useQuery(providerQuery);
  const mossReady = computed(() => {
    const status = ready(providers, undefined);
    if (!status) return true;
    return status.connections.some((c) => c.adapter === "moss" && c.enabled && c.key.source !== null);
  });
  const state = signal<LiveVoiceSnapshot>(initialCallState);
  const error = signal<string | undefined>(undefined);
  const liveSince = signal<number | undefined>(undefined);
  const now = signal(Date.now());
  const act = createAct((why) => error.set(why));
  let polling = false;
  let closed = false;
  let starting = false;
  const id = crypto.randomUUID();
  const command = async (op: string, payload = {}) => {
    if (op === "host.voiceStart") starting = true;
    const result = await transport().call(op, { ...payload, id });
    if (closed && op === "host.voiceStart") {
      const stopped = await transport().call("host.voiceStop", { id });
      if (stopped.bizCode !== 0) console.warn("voice stop:", stopped.message);
    }
    if (op === "host.voiceStart") starting = false;
    if (result.bizCode !== 0) throw new Error(result.message);
    if (!closed) {
      const next = HostLiveVoiceState.parse(result.data);
      state.set(next);
      if (next.phase === "live") {
        if (liveSince() === undefined) {
          const at = Date.now();
          liveSince.set(at);
          now.set(at);
        }
      } else if (liveSince() !== undefined) {
        liveSince.set(undefined);
      }
    }
  };
  useInterval(() => {
    if (liveSince() !== undefined) now.set(Date.now());
    if (polling || state().phase === "idle") return;
    polling = true;
    void command("host.voiceState")
      .catch((why: unknown) => error.set(String(why)))
      .finally(() => {
        polling = false;
      });
  }, 120);
  cleanup(() => {
    closed = true;
    if (starting || state().phase !== "idle") void command("host.voiceStop").catch((why: unknown) => console.warn("voice stop:", why));
  });
  const active = () => state().phase !== "idle";
  const elapsed = () => {
    const started = liveSince();
    return started === undefined ? "00:00" : formatElapsed(now() - started);
  };
  const stagePrompt = () => {
    switch (state().phase) {
      case "connecting":
        return t("web.voice.moss.connecting");
      case "live":
        return state().muted ? t("web.voice.moss.mutedLabel") : t("web.voice.moss.listeningPrompt");
      case "stopping":
        return t("web.voice.moss.hangUp");
      case "idle":
        return mossReady() ? t("web.voice.moss.readyPrompt") : t("web.setting.missing.mossAccount");
    }
  };

  return (
    <View testID="native-call" class="overflow-hidden rounded-xl border border-line bg-elevated">
      <View class="flex-row flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <View class="min-w-0 flex-row items-center gap-2.5">
          <Text role="header" class="text-sm font-semibold text-ink">
            {t("web.voice.moss.nativeCall")}
          </Text>
          <PhasePill phase={state().phase} muted={state().muted} elapsed={elapsed()} />
        </View>
        <MossVerify />
      </View>

      <View class="items-center gap-3.5 bg-page px-6 py-6">
        <VoiceOrb phase={state().phase} muted={state().muted} micLevel={state().micLevel} />
        <MicWaveform
          testid="native-call-waveform"
          level={state().micLevel}
          active={state().phase === "live"}
          muted={state().muted}
          bars={18}
          label={stagePrompt()}
        />
        <Text class="text-center text-xs font-medium text-muted">{stagePrompt()}</Text>
        <View class="flex-row flex-wrap items-center justify-center gap-2 pt-0.5">
          <Button
            tone={mossReady() ? "primary" : "plain"}
            icon="call"
            testID="native-call-start"
            disabled={act.busy() || active() || !mossReady()}
            onPress={() => void act.run(() => command("host.voiceStart"))}
          >
            {state().phase === "connecting" ? t("web.voice.moss.connecting") : t("web.voice.moss.talk")}
          </Button>
          <Button
            tone={state().muted ? "danger" : "plain"}
            icon="record"
            testID="native-call-mute"
            tooltip={<Bubble text={state().muted ? t("web.voice.moss.unmute") : t("web.voice.moss.mute")} />}
            disabled={state().phase !== "live"}
            onPress={() => void act.run(() => command("host.voiceMute", { muted: !state().muted }))}
          >
            {state().muted ? t("web.voice.moss.unmute") : t("web.voice.moss.mute")}
          </Button>
          <Button
            tone="danger"
            icon="stop"
            testID="native-call-stop"
            tooltip={<Bubble text={t("web.voice.moss.hangUp")} />}
            disabled={!active()}
            onPress={() => void act.run(() => command("host.voiceStop"))}
          >
            {t("web.voice.moss.hangUp")}
          </Button>
        </View>
      </View>

      <View class="gap-2.5 border-t border-line bg-side px-4 py-3">
        <If when={error() ?? state().problem}>
          {(why) => (
            <Banner testID="native-call-error" role="alert">
              {why()}
            </Banner>
          )}
        </If>
        <If when={state().heard}>
          {(words) => (
            <View class="flex-row items-start gap-2 rounded-lg border border-line bg-elevated px-3 py-2">
              <View class="mt-0.5 shrink-0">
                <Icon name="record" size={14} tone="muted" />
              </View>
              <View class="min-w-0 flex-1 gap-0.5">
                <Text class="text-2xs font-medium text-faint">{t("web.voice.moss.youLabel")}</Text>
                <Text testID="native-call-heard" class="text-sm leading-relaxed text-ink">
                  {words()}
                </Text>
              </View>
            </View>
          )}
        </If>
        <If when={state().said}>
          {(words) => (
            <View class="flex-row items-start gap-2 rounded-lg border border-line bg-ok-soft px-3 py-2">
              <View class="mt-0.5 shrink-0">
                <Icon name="realtime" size={14} tone="ok-ink" />
              </View>
              <View class="min-w-0 flex-1 gap-0.5">
                <Text class="text-2xs font-medium text-ok-ink">{t("web.voice.moss.orchestratorLabel")}</Text>
                <Text testID="native-call-said" class="text-sm leading-relaxed text-ink">
                  {words()}
                </Text>
              </View>
            </View>
          )}
        </If>
        <View class="flex-row items-start gap-2">
          <View class="mt-0.5 shrink-0">
            <Icon name="info" size={12} tone="faint" />
          </View>
          <Text class="min-w-0 flex-1 text-xs leading-relaxed text-faint">{t("web.voice.moss.nativeNotice")}</Text>
        </View>
      </View>
    </View>
  );
}
