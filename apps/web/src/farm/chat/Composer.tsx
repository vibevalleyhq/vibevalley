import { t } from "@vibevalley/i18n";
// The farm chat's input row, at the foot of the unfolded phone's right screen: who the next job goes to, the box (Enter
// sends, Shift+Enter starts a line, @ names someone), dictation, and the stop button while the orchestrator thinks. Calling
// the orchestrator is the phone's (its 管家), so the row has no call key. A failed
// send keeps the draft and its key, so a retry is the same message, not a second one.

import { farmWording } from "../words";
import { For, Show } from "solid-js";
import type { Channel } from "@vibevalley/protocol";
import { api } from "../../base/api";
import { createComposer, draftOf, drafts, threadOwnerOf } from "../../features/channel";

import { aria } from "../../base/util";
import { useCore } from "../../base/frame";
import { AgentFace } from "../../ui/Face";
import { DictationButton } from "../../features/voice";
import { SpriteIcon } from "../../ui/pixel";

import { useAgent } from "../../base/agents";
import { setPick, usePrefs } from "../../base/prefs";

/** Who the next line goes to, with a button to stop picking. */
function PickChip(props: { named: boolean }) {
  const pick = usePrefs((p) => p.pick);
  const agent = useAgent(pick);
  return (
    <Show when={pick() !== "auto" && agent()?.enabled ? agent() : undefined}>
      {(a) => (
        <span class="mr-1 flex h-8 shrink-0 items-center gap-1 bg-cream-200 pr-1 pl-0.5" title={t("web.farm.chat.sendTo", { name: a().name })}>
          <AgentFace agentId={a().id} runtime={a().runtime} look={a().look} size={26} />
          <Show when={props.named}>
            <span class="max-w-20 truncate text-[12px] text-bark-800">{t("web.farm.chat.sendTo", { name: a().name })}</span>
          </Show>
          <button
            type="button"
            aria-label={t("web.farm.chat.anyone")}
            onClick={() => setPick("auto")}
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

export function FarmComposer(props: { channel: Channel | undefined; thread: boolean; onProblem: (p: string | undefined) => void }) {
  const core = useCore();
  const pick = usePrefs((p) => p.pick);
  let input: HTMLTextAreaElement | undefined;
  const owner = () => (props.thread && props.channel ? threadOwnerOf(props.channel, core()?.sessions ?? []) : undefined);
  const placeholder = () =>
    props.thread
      ? owner()
        ? t("web.farm.chat.inThread", { name: owner()!.name })
        : t("web.farm.chat.inThreadAnyone")
      : props.channel?.type === "direct"
        ? t("web.farm.chat.toOrchestratorAlone")
        : t("web.farm.chat.toOrchestrator");

  const box = createComposer(core, () => input, {
    target: () => {
      const reply = draftOf(props.channel?.id).reply;
      return { id: props.channel?.id ?? "", agent: props.thread || pick() === "auto" ? undefined : pick(), ...(reply ? { replyTo: reply.number } : {}) };
    },
    // The farm's window draws the line at once (ChatWindow), so the box empties as it is sent.
    echo: true,
    failed: (reason) => props.onProblem(t("web.farm.chat.notSent", { why: reason })),
    edited: () => props.onProblem(undefined),
    sent: () => {
      const id = props.channel?.id;
      if (id) drafts.reply(id, undefined);
    },
  });
  const replying = () => draftOf(props.channel?.id).reply;

  return (
    <div class="relative flex flex-col border-t border-cream-200 p-1.5">
      <Show when={replying()}>
        {(m) => (
          <div class="mb-1 flex items-center gap-1.5 bg-cream-100 px-2 py-1">
            <span class="min-w-0 flex-1 truncate font-pixel text-[12px] text-bark-500">{farmWording().chat.replyTo(m().name, m().text)}</span>
            <button
              type="button"
              aria-label={t("web.farm.chat.actions.cancelReply")}
              onClick={() => drafts.reply(m().channel, undefined)}
              class="cursor-pointer p-0.5"
            >
              <SpriteIcon name="button-close" size={12} />
            </button>
          </div>
        )}
      </Show>
      <div class="relative flex items-end gap-1.5">
        <Show when={box.offered().length > 0}>
          <div
            class="absolute right-2 bottom-full left-2 mb-1 border-2 border-cream-300 bg-cream-50 py-1 shadow-px"
            role="listbox"
            aria-label={t("web.farm.chat.who")}
          >
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
              aria-label={t("web.farm.chat.stop")}
              title={t("web.farm.chat.stopHint")}
              onClick={() => void api.orchestrator.stop({ agent: box.here() }).catch(() => {})}
              class="cursor-pointer p-1"
            >
              <SpriteIcon name="button-stop" size={24} />
            </button>
          </Show>
          <DictationButton field={() => input} value={box.text()} onValue={box.edit} />
          <button
            type="button"
            aria-label={t("web.farm.chat.send")}
            disabled={!box.canSend()}
            onClick={() => void box.send()}
            class="cursor-pointer p-1 disabled:opacity-40"
          >
            <SpriteIcon name="button-send" size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
