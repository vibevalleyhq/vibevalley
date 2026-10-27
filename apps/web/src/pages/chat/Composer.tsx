import { mentionOf } from "../../rules/chat";
import { orchestratorAgent } from "@vibevalley/protocol";
import { chatWording } from "./words";
import { createSignal, For, Show } from "solid-js";
import type { Conversation } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { createComposer } from "../../data/composer";
import { toast } from "../../ui/toasts";
import { aria } from "../../app/util";
import { useCore } from "../../data/frame";
import { OrchestratorFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { DictationButton } from "../../voice/DictationButton";
import { HelperFace } from "./bits";

/** The box for saying a sentence in a conversation: Enter sends, Shift+Enter starts a line, @ names someone. */
export function Composer(props: { conversation: Conversation | undefined; placeholder: string }) {
  const core = useCore();
  let input: HTMLTextAreaElement | undefined;
  const [problem, setProblem] = createSignal<string>();
  const box = createComposer(core, () => input, {
    target: () => ({ conversation: props.conversation?.id }),
    failed: (reason) => {
      setProblem(reason);
      toast(chatWording().composer.notSent(reason), "bad");
    },
    edited: () => setProblem(undefined),
  });
  const stop = () => api.orchestrator.stop().catch((e) => toast(reasonOf(e), "bad"));

  return (
    <div class="border-t border-line px-4 pt-3 pb-4">
      <Show when={box.offered().length > 0}>
        <div role="listbox" aria-label={chatWording().composer.who} class="mb-1.5 flex flex-col rounded-lg border border-line bg-page p-1 shadow-float">
          <For each={box.offered()} keyed={(n) => n.token}>
            {(n, i) => (
              <div
                role="option"
                aria-selected={aria(i() === box.active())}
                onMouseEnter={() => box.setActive(i())}
                // Keeps the focus in the input.
                onMouseDown={(e) => {
                  e.preventDefault();
                  box.choose(n());
                }}
                class={["flex cursor-pointer items-center gap-2 rounded-md px-2 py-1", { "bg-selected": i() === box.active() }]}
              >
                <Show when={n().session} fallback={n().token === mentionOf[orchestratorAgent] ? <OrchestratorFace size={20} /> : <span class="size-5" />}>
                  {(s) => <HelperFace agent={s().agent} runtime={s().runtime} size={20} />}
                </Show>
                <span class="font-mono text-xs">{n().token}</span>
                <Show when={n().session}>
                  <span class="text-sm">{n().name}</span>
                </Show>
                <span class="min-w-0 flex-1 truncate text-xs text-muted">{n().note}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={problem()}>{(p) => <p class="mb-1.5 text-xs text-berry">{p()}</p>}</Show>
      <div class="rounded-lg border border-line bg-page focus-within:border-focus">
        <textarea
          ref={(el) => (input = el)}
          value={box.text()}
          rows={2}
          aria-label={props.placeholder}
          placeholder={props.placeholder}
          onInput={(e) => box.edit(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyUp={box.follow}
          onClick={box.follow}
          onKeyDown={box.onKey}
          onBlur={box.blur}
          onFocus={box.focus}
          class="block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base outline-none [field-sizing:content] placeholder:text-faint"
        />
        <div class="flex items-center gap-1 px-2 pb-2">
          <span class="text-xs text-faint">{chatWording().composer.mention}</span>
          <span class="flex-1" />
          <DictationButton field={() => input} value={box.text()} onValue={box.edit} size={16} class="rounded-md hover:bg-hover" />
          <Show when={box.stoppable()}>
            <button
              type="button"
              onClick={() => void stop()}
              aria-label={chatWording().composer.stop}
              title={chatWording().composer.stopHint}
              class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md border border-line text-berry hover:bg-hover"
            >
              <Icon name="button-stop" size={14} />
            </button>
          </Show>
          <button
            type="button"
            onClick={() => void box.send()}
            disabled={!box.canSend()}
            aria-label={chatWording().composer.send}
            title={chatWording().composer.sendHint}
            class={[
              "inline-flex size-7 cursor-pointer items-center justify-center rounded-md border disabled:cursor-default",
              box.canSend() ? "border-accent bg-accent hover:bg-leaf" : "border-transparent opacity-50",
            ]}
          >
            <Icon name="button-send" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
