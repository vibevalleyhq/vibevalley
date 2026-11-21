import { cleanup, signal, Text, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";

import { useInterval } from "../../../base/timer";
import { transport } from "../../../infra/transport";
import { createAct } from "../../../ui/act";
import { Button } from "../../../ui/Button";
import { Icon } from "../../../ui/Icon";
import { Banner, Card } from "../../../ui/layout";
import { Dot } from "../../../ui/Tag";
import { Bubble } from "../../../ui/Tip";
import { mix } from "../../../ui/tone";

const CallState = z.object({
  phase: z.enum(["idle", "connecting", "live", "stopping"]),
  muted: z.boolean(),
  problem: z.string().nullable(),
  heard: z.string(),
  said: z.string(),
});

type CallPhase = z.infer<typeof CallState>["phase"];

const formatElapsed = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const phaseMeta = (phase: CallPhase, elapsed: string) => {
  switch (phase) {
    case "idle":
      return undefined;
    case "connecting":
      return { dot: "wheat" as const, bgClass: "", wheat: true, textClass: "text-warn-ink", label: t("web.voice.moss.connecting"), mono: false };
    case "live":
      return { dot: "leaf" as const, bgClass: "bg-ok-soft", wheat: false, textClass: "text-ok-ink", label: elapsed, mono: true };
    case "stopping":
      return { dot: "wheat" as const, bgClass: "", wheat: true, textClass: "text-warn-ink", label: t("web.voice.moss.hangUp"), mono: false };
  }
};

function PhasePill(props: { phase: CallPhase; muted: boolean; elapsed: string }) {
  const meta = () => phaseMeta(props.phase, props.elapsed);
  return (
    <View class="flex-row items-center gap-1.5">
      <If when={meta()} else={<Dot tone="idle" size={7} ring={false} />}>
        {(m) => (
          <View
            class={`h-6 flex-row items-center gap-1.5 rounded-sm px-2 ${m().bgClass}`}
            style={m().wheat ? { backgroundColor: mix("wheat", 0.22) } : undefined}
          >
            <Dot tone={m().dot} size={6} ring={false} />
            <Text class={`text-xs font-medium ${m().mono ? "font-mono tabular-nums" : ""} ${m().textClass}`}>{m().label}</Text>
          </View>
        )}
      </If>
      <If when={props.phase === "live" && props.muted}>
        <View class="h-6 flex-row items-center gap-1 rounded-sm bg-bad-soft px-2">
          <Icon name="record" size={12} tone="berry" />
          <Text class="text-xs font-medium text-berry">{t("web.voice.moss.mute")}</Text>
        </View>
      </If>
    </View>
  );
}

export function NativeCall() {
  const state = signal<z.infer<typeof CallState>>({ phase: "idle", muted: false, problem: null, heard: "", said: "" });
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
      const next = CallState.parse(result.data);
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
  }, 500);
  cleanup(() => {
    closed = true;
    if (starting || state().phase !== "idle") void command("host.voiceStop").catch((why: unknown) => console.warn("voice stop:", why));
  });
  const active = () => state().phase !== "idle";
  const elapsed = () => {
    const started = liveSince();
    return started === undefined ? "00:00" : formatElapsed(now() - started);
  };
  return (
    <Card title={t("web.voice.moss.nativeCall")} action={<PhasePill phase={state().phase} muted={state().muted} elapsed={elapsed()} />} class="max-w-4xl">
      <View testID="native-call" class="gap-3">
        <View class="flex-row items-start gap-2 rounded-md bg-side px-3 py-2.5">
          <View class="mt-0.5 shrink-0">
            <Icon name="info" size={14} tone="faint" />
          </View>
          <Text class="min-w-0 flex-1 text-xs leading-relaxed text-muted">{t("web.voice.moss.nativeNotice")}</Text>
        </View>
        <View class="flex-row flex-wrap items-center gap-2">
          <Button
            tone="primary"
            icon="call"
            testID="native-call-start"
            disabled={act.busy() || active()}
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
        <If when={error() ?? state().problem}>
          {(why) => (
            <Banner testID="native-call-error" role="alert">
              {why()}
            </Banner>
          )}
        </If>
        <If when={state().heard}>
          {(words) => (
            <View class="flex-row items-start gap-2 rounded-md bg-side px-3 py-2">
              <View class="mt-0.5 shrink-0">
                <Icon name="record" size={14} tone="muted" />
              </View>
              <Text testID="native-call-heard" class="min-w-0 flex-1 text-sm leading-relaxed text-muted">
                {words()}
              </Text>
            </View>
          )}
        </If>
        <If when={state().said}>
          {(words) => (
            <View class="flex-row items-start gap-2 rounded-md bg-ok-soft px-3 py-2">
              <View class="mt-0.5 shrink-0">
                <Icon name="realtime" size={14} tone="ok-ink" />
              </View>
              <Text testID="native-call-said" class="min-w-0 flex-1 text-sm leading-relaxed text-ink">
                {words()}
              </Text>
            </View>
          )}
        </If>
      </View>
    </Card>
  );
}
