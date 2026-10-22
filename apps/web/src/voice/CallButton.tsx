// The call to the assistant: on, off, and how loud you are while it is on.

import { Show } from "solid-js";
import { voiceCall } from "./call";
import { aria } from "../app/util";
import { createExternal } from "../data/external";
import { Icon } from "../ui/Icon";

const mood: Record<string, string> = { speaking: "在说话", listening: "在听", thinking: "在想", idle: "在听", silent: "在听" };

/** The call as an accessor: the store counts its changes, so each read of the call goes through `version`. */
export function createCall() {
  const version = createExternal(voiceCall.subscribe, () => voiceCall.version);
  return () => (version(), voiceCall);
}

export function CallButton() {
  const call = createCall();
  const live = () => call().phase === "live";
  const joining = () => call().phase === "connecting";
  const leaving = () => call().phase === "ending";
  const failed = () => call().phase === "idle" && call().problem !== undefined;
  const tip = () =>
    live()
      ? `挂断语音。管家${call().agentHere ? (mood[call().agentState ?? ""] ?? "在听") : "还在路上"}`
      : joining()
        ? "正在接通管家…"
        : leaving()
          ? "挂断中…"
          : failed()
            ? `上次没接通：${call().problem}。再按一下重试`
            : "按一下，和管家语音说话";
  const fill = () => (leaving() ? "#c8a46e" : live() ? "#c84a3a" : failed() ? "#c9813a" : "#74a046");
  return (
    <button
      type="button"
      title={tip()}
      aria-label={live() || joining() ? "挂断语音" : "语音说话"}
      aria-pressed={aria(live())}
      disabled={leaving()}
      onClick={() => void voiceCall.toggle()}
      class="relative flex size-11 shrink-0 cursor-pointer items-center justify-center shadow-[0_3px_0_#0000002e] hover:brightness-95 active:translate-y-px"
      style={{ background: fill() }}
    >
      <Show when={live()}>
        <span class="absolute inset-0 bg-berry/35" style={{ transform: `scale(${1 + Math.min(1, (call().micLevel / 100) * 1.6) * 0.45})` }} />
      </Show>
      <Show when={joining() || leaving()} fallback={<Icon name={live() ? "button-hangup" : "button-mic"} size={20} class="relative" />}>
        <span class="size-4 animate-spin rounded-full border-2 border-cream-50/50 border-t-cream-50" />
      </Show>
    </button>
  );
}
