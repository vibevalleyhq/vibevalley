// The dictation button every input row has, and the farm's call button.

import { useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef } from "react";
import { api } from "../data/api";
import { Icon } from "../ui/Icon";
import { useCall } from "./call";
import { insertDictated, useDictation } from "./dictation";

/** Tap to start talking, tap again to stop: the words go into the field at its caret, for the owner to read before sending. */
export function DictationButton({
  field,
  value,
  onValue,
  size = 20,
  className = "",
}: {
  field: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  value: string;
  onValue: (v: string, caret: number) => void;
  size?: number;
  className?: string;
}) {
  const dictation = useDictation();
  const me = useRef({});
  // What the words go into, as it is when they come.
  const latest = useRef({ value, onValue });
  latest.current = { value, onValue };
  useEffect(() => () => dictation.release(me.current), [dictation]);
  // Unknown until the settings are read; the server says what is missing then.
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.setting.load() }).data;
  const off = settings !== undefined && settings.dictation.url === "";
  const [icon, tip] = off
    ? ["button-record", "听写还没配：在「声音」页的「听写」里填地址和模型"]
    : dictation.phase === "recording"
      ? ["button-stop", "在听…再点一下停"]
      : dictation.phase === "transcribing"
        ? ["button-wait", "在认字…"]
        : ["button-record", dictation.problem ? `上次没认出来：${dictation.problem}` : "听写：点一下开始说，再点一下停"];
  return (
    <button
      type="button"
      aria-label={dictation.phase === "recording" ? "停下听写" : "听写"}
      title={tip}
      disabled={off || dictation.phase === "transcribing"}
      onClick={() =>
        void dictation.toggle(me.current, (words) => {
          const el = field.current;
          const { value: now, onValue: put } = latest.current;
          const start = el?.selectionStart ?? now.length;
          const end = el?.selectionEnd ?? now.length;
          const next = insertDictated(now, start, end, words);
          put(next.value, next.caret);
          requestAnimationFrame(() => {
            el?.focus();
            el?.setSelectionRange(next.caret, next.caret);
          });
        })
      }
      className={`shrink-0 cursor-pointer p-1 disabled:cursor-default disabled:opacity-40 ${dictation.phase === "recording" ? "animate-pulse" : ""} ${className}`}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

const mood: Record<string, string> = { speaking: "在说话", listening: "在听", thinking: "在想", idle: "在听", silent: "在听" };

/** The call to the manager: on, off, and how loud you are while it is on. */
export function CallButton() {
  const call = useCall();
  const live = call.phase === "live";
  const joining = call.phase === "connecting";
  const leaving = call.phase === "ending";
  const failed = call.phase === "idle" && call.problem !== undefined;
  const tip = live
    ? `挂断语音。管家${call.agentHere ? (mood[call.agentState ?? ""] ?? "在听") : "还在路上"}`
    : joining
      ? "正在接通管家…"
      : leaving
        ? "挂断中…"
        : failed
          ? `上次没接通：${call.problem}。再按一下重试`
          : "按一下，和管家语音说话";
  const fill = leaving ? "#c8a46e" : live ? "#c84a3a" : failed ? "#c9813a" : "#74a046";
  return (
    <button
      type="button"
      title={tip}
      aria-label={live || joining ? "挂断语音" : "语音说话"}
      aria-pressed={live}
      disabled={leaving}
      onClick={() => void call.toggle()}
      className="relative flex size-11 shrink-0 cursor-pointer items-center justify-center shadow-[0_3px_0_#0000002e] hover:brightness-95 active:translate-y-px"
      style={{ background: fill }}
    >
      {live && <span className="absolute inset-0 bg-berry/35" style={{ transform: `scale(${1 + Math.min(1, (call.micLevel / 100) * 1.6) * 0.45})` }} />}
      {joining || leaving ? (
        <span className="size-4 animate-spin rounded-full border-2 border-cream-50/50 border-t-cream-50" />
      ) : (
        <Icon name={live ? "button-hangup" : "button-mic"} size={20} className="relative" />
      )}
    </button>
  );
}
