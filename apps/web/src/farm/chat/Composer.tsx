// The farm chat window's input row: the orchestrator's face that opens and folds the window, who the next job goes to, the
// box (Enter sends, Shift+Enter starts a line, @ names someone), and the stop button while the orchestrator thinks. A failed
// send keeps the draft and its key, so a retry is the same message, not a second one.

import { For, Show } from "solid-js";
import type { Conversation } from "@vibevalley/protocol";
import { api } from "../../data/api";
import { createComposer, say } from "../../data/composer";
import { playSound } from "../sound";
import { farm } from "../store";
import { threadOwnerOf, typedName } from "../../rules/chat";
import { aria } from "../../app/util";
import { useCore } from "../../data/frame";
import { AgentFace, OrchestratorFace } from "../../ui/Face";
import { CallButton } from "../../voice/CallButton";
import { DictationButton } from "../../voice/DictationButton";
import { SpriteIcon } from "../kit";
import { useFarm } from "../state";
import { useAgent } from "../../data/agents";

/** Who the next line goes to, with a button to stop picking. */
function PickChip(props: { named: boolean }) {
  const pick = useFarm((s) => s.pick);
  const agent = useAgent(pick);
  return (
    <Show when={pick() !== "auto" && agent()?.enabled ? agent() : undefined}>
      {(a) => (
        <span class="mr-1 flex h-8 shrink-0 items-center gap-1 bg-cream-200 pr-1 pl-0.5" title={`派给${a().name}`}>
          <AgentFace agentId={a().id} look={a().look} size={26} />
          <Show when={props.named}>
            <span class="max-w-20 truncate text-[12px] text-bark-800">派给{a().name}</span>
          </Show>
          <button
            type="button"
            aria-label="不指定帮工"
            onClick={() => farm.setPick("auto")}
            class="flex h-6 w-6 cursor-pointer items-center justify-center hover:bg-cream-300"
          >
            <SpriteIcon name="button-close" size={12} />
          </button>
        </span>
      )}
    </Show>
  );
}

export type ChatPhase = "off" | "connecting" | "listening" | "thinking" | "speaking" | "error";

const ring: Record<ChatPhase, string> = {
  off: "#c8a46e",
  connecting: "#c8a46e",
  listening: "#74a046",
  thinking: "#c8a46e",
  speaking: "#e5a93c",
  error: "#c84a3a",
};

export function FarmComposer(props: {
  conversation: Conversation | undefined;
  thread: boolean;
  phase: ChatPhase;
  open: boolean;
  unread: boolean;
  onProblem: (p: string | undefined) => void;
}) {
  const core = useCore();
  const look = useFarm((s) => s.orchestratorLook);
  const pick = useFarm((s) => s.pick);
  let input: HTMLTextAreaElement | undefined;
  const owner = () => (props.thread && props.conversation ? threadOwnerOf(props.conversation, core()?.sessions ?? []) : undefined);
  const placeholder = () => (props.thread ? (owner() ? `在串里说，${owner()!.name}会看到…` : "在串里说…") : "对管家说，@ 叫帮工…");

  const box = createComposer(core, () => input, {
    send: (said, sendKey) => say(said, props.conversation, sendKey, props.thread || pick() === "auto" ? undefined : pick()),
    where: () => props.conversation,
    failed: (reason) => props.onProblem(`没发出去：${reason}`),
    edited: (value, at) => {
      props.onProblem(undefined);
      // Naming someone opens the window, to show who can be named.
      if (!props.open && typedName(value, at)) farm.chatOpen(true);
    },
  });

  return (
    <div class={["relative flex items-end gap-1.5 p-1.5", { "border-t border-cream-200": props.open }]}>
      <Show when={box.offered().length > 0}>
        <div class="absolute right-2 bottom-full left-2 mb-1 border-2 border-cream-300 bg-cream-50 py-1 shadow-px" role="listbox" aria-label="叫谁">
          <For each={box.offered()} keyed={(n) => n.token}>
            {(n, i) => (
              <button
                type="button"
                role="option"
                aria-selected={aria(i() === box.active())}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => box.choose(n())}
                class={["flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left text-[12px]", { "bg-leaf-300/40": i() === box.active() }]}
              >
                <span class="text-bark-900">{n().name}</span>
                <span class="truncate text-bark-500">{n().note}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <button
        type="button"
        aria-label={props.open ? "收起对话" : "展开对话"}
        title={props.open ? "收起对话" : props.unread ? "田头有新话，点开看看" : "展开对话"}
        onClick={() => {
          playSound(props.open ? "close" : "open");
          farm.chatOpen(!props.open);
        }}
        class="relative shrink-0 cursor-pointer p-0.5 shadow-[inset_0_0_0_2px_#2f1f1340]"
        style={{ background: ring[props.phase] }}
      >
        <OrchestratorFace size={40} look={look()} />
        <Show when={props.unread}>
          <span class="absolute -top-0.5 -right-0.5 h-3 w-3 bg-berry shadow-[inset_0_0_0_2px_#2f1f1340]" />
        </Show>
      </button>
      <div class="flex min-h-11 min-w-0 flex-1 items-center bg-cream-50 px-1 shadow-[inset_0_0_0_2px_#c8a46e]">
        <Show when={!props.thread}>
          <PickChip named />
        </Show>
        <textarea
          ref={(el) => (input = el)}
          rows={1}
          value={box.text()}
          placeholder={placeholder()}
          aria-label={placeholder()}
          onInput={(e) => box.edit(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyUp={box.follow}
          onClick={box.follow}
          onKeyDown={box.onKey}
          class="max-h-24 min-w-0 flex-1 resize-none bg-transparent px-1 py-2 font-pixel text-[12px] leading-4 text-bark-900 outline-none placeholder:text-bark-400"
        />
        <Show when={box.stoppable()}>
          <button
            type="button"
            aria-label="叫管家停下"
            title="叫管家停下这一轮，派出去的帮工照常干活"
            onClick={() => void api.orchestrator.stop().catch(() => {})}
            class="cursor-pointer p-1"
          >
            <SpriteIcon name="button-stop" size={24} />
          </button>
        </Show>
        <DictationButton field={() => input} value={box.text()} onValue={box.edit} />
        <button type="button" aria-label="发送" disabled={!box.canSend()} onClick={() => void box.send()} class="cursor-pointer p-1 disabled:opacity-40">
          <SpriteIcon name="button-send" size={20} />
        </button>
      </div>
      <Show when={!props.thread}>
        <CallButton />
      </Show>
    </div>
  );
}
