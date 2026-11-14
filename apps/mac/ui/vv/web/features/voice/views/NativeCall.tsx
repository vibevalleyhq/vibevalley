import { cleanup, signal, Text, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";

import { useInterval } from "../../../base/timer";
import { transport } from "../../../infra/transport";
import { createAct } from "../../../ui/act";
import { Button } from "../../../ui/Button";
import { Card } from "../../../ui/layout";

const CallState = z.object({
  phase: z.enum(["idle", "connecting", "live", "stopping"]),
  muted: z.boolean(),
  problem: z.string().nullable(),
  heard: z.string(),
  said: z.string(),
});

export function NativeCall() {
  const state = signal<z.infer<typeof CallState>>({ phase: "idle", muted: false, problem: null, heard: "", said: "" });
  const error = signal<string | undefined>(undefined);
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
    if (!closed) state.set(CallState.parse(result.data));
  };
  useInterval(() => {
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
  return (
    <Card title={t("web.voice.moss.nativeCall")}>
      <View testID="native-call" class="gap-3">
        <Text class="text-sm text-muted">{t("web.voice.moss.nativeNotice")}</Text>
        <View class="flex-row gap-2">
          <Button testID="native-call-start" disabled={act.busy() || active()} onPress={() => void act.run(() => command("host.voiceStart"))}>
            {state().phase === "connecting" ? t("web.voice.moss.connecting") : t("web.voice.moss.talk")}
          </Button>
          <Button testID="native-call-stop" disabled={!active()} onPress={() => void act.run(() => command("host.voiceStop"))}>
            {t("web.voice.moss.hangUp")}
          </Button>
          <Button
            testID="native-call-mute"
            disabled={state().phase !== "live"}
            onPress={() => void act.run(() => command("host.voiceMute", { muted: !state().muted }))}
          >
            {state().muted ? t("web.voice.moss.unmute") : t("web.voice.moss.mute")}
          </Button>
        </View>
        <If when={error() ?? state().problem}>
          {(why) => (
            <Text testID="native-call-error" class="text-sm text-berry">
              {why()}
            </Text>
          )}
        </If>
        <If when={state().heard}>
          {(words) => (
            <Text testID="native-call-heard" class="text-sm text-muted">
              {words()}
            </Text>
          )}
        </If>
        <If when={state().said}>
          {(words) => (
            <Text testID="native-call-said" class="text-sm text-ink">
              {words()}
            </Text>
          )}
        </If>
      </View>
    </Card>
  );
}
