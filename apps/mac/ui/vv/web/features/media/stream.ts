import { t } from "@vibevalley/i18n";
import { subscriptions } from "@vibevalley/protocol/rpc";

import { transport } from "../../infra/transport";

export function playSpeech(id: string, changed: (state: "playing" | "done") => void, failed: (error: string) => void) {
  const bridge = transport();
  let stopped = false;
  let done = false;
  let formatted = false;
  let sequence = 0;
  let queued = 0;
  let chain = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  const call = async (op: string, payload: unknown) => {
    const reply = await bridge.call(op, payload);
    if (reply.bizCode !== 0) throw new Error(reply.message);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
    void call("host.stopAudio", {}).catch((error: unknown) => failed(error instanceof Error ? error.message : String(error)));
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    stop();
    failed(error instanceof Error ? error.message : String(error));
  };
  if (!bridge.subscribe) {
    failed(t("web.audio.flashUnsupported"));
    return stop;
  }
  unsubscribe = bridge.subscribe(
    "media.speech.stream",
    { id },
    (raw) => {
      if (stopped) return;
      const event = subscriptions["media.speech.stream"].event.safeParse(raw);
      if (!event.success) {
        fail(t("web.audio.flashInvalid"));
        return;
      }
      const item = event.data;
      const size = item.type === "audio" ? item.audio.length : 0;
      queued += size;
      if (queued > 2 << 20) {
        fail(t("web.audio.flashInvalid"));
        return;
      }
      chain = chain
        .then(async () => {
          queued -= size;
          if (stopped) return;
          if (done) throw new Error(t("web.audio.flashInvalid"));
          switch (item.type) {
            case "format":
              if (formatted || item.bitDepth !== 16) throw new Error(t("web.audio.flashInvalid"));
              await call("host.pcmStart", { sampleRate: item.sampleRate, channels: item.channels });
              formatted = true;
              changed("playing");
              break;
            case "audio":
              if (!formatted || item.sequence !== sequence++) throw new Error(t("web.audio.flashInvalid"));
              await call("host.pcmAppend", { data: item.audio });
              break;
            case "done":
              done = true;
              changed("done");
              break;
            case "failed":
              throw new Error(t("web.audio.flashInvalid"));
          }
        })
        .catch(fail);
    },
    (why) => {
      void chain.then(() => {
        if (!stopped && !done) fail(why?.message ?? t("web.audio.flashInvalid"));
      });
    },
  );
  return stop;
}
