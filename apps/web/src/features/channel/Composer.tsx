import { mentionOf } from "./rules";
import { orchestratorAgent, ownerId } from "@vibevalley/protocol";
import { draftOf, drafts, upload } from "./draft";
import { chatWording } from "./words";
import { createSignal, For, Show } from "solid-js";
import type { Channel } from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import { createComposer } from "./composing";
import { toast } from "../../ui/toasts";
import { aria } from "../../base/util";
import { useCore } from "../../base/frame";
import { OrchestratorFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { DictationButton } from "../voice";
import { HelperFace } from "./bits";

/** The box for saying a sentence in a channel: Enter sends, Shift+Enter starts a line, @ names someone. */
export function Composer(props: { channel: Channel | undefined; placeholder: string }) {
  const core = useCore();
  let input: HTMLTextAreaElement | undefined;
  const [problem, setProblem] = createSignal<string>();
  const [uploading, setUploading] = createSignal(0);
  const draft = () => draftOf(props.channel?.id);
  const box = createComposer(core, () => input, {
    target: () => {
      const d = draft();
      return {
        id: props.channel?.id ?? "",
        ...(d.reply ? { replyTo: d.reply.number } : {}),
        ...(d.files.length > 0 ? { attachments: d.files.map((f) => f.id) } : {}),
      };
    },
    failed: (reason) => {
      setProblem(reason);
      toast(chatWording().composer.notSent(reason), "bad");
    },
    edited: () => setProblem(undefined),
    sent: () => {
      const id = props.channel?.id;
      if (id) drafts.clear(id);
    },
  });
  /** Files picked or pasted go up at once; the line carries them once they are there. */
  const attach = async (files: readonly File[]) => {
    const id = props.channel?.id;
    if (!id || files.length === 0) return;
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        drafts.add(id, await upload(file));
      } catch (e) {
        toast(chatWording().composer.uploadFailed(reasonOf(e)), "bad");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  let picker: HTMLInputElement | undefined;
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
      <Show when={draft().reply}>
        {(m) => (
          <div class="mb-1.5 flex items-center gap-2 rounded-md bg-hover px-3 py-1.5 text-xs text-muted">
            <Icon name="button-back" size={12} />
            <span class="min-w-0 flex-1 truncate">
              {chatWording().composer.replying(m().from === ownerId ? chatWording().messages.owner : m().name)}：{m().text}
            </span>
            <button
              type="button"
              class="cursor-pointer rounded p-0.5 hover:bg-page"
              aria-label={chatWording().composer.cancelReply}
              title={chatWording().composer.cancelReply}
              onClick={() => drafts.reply(props.channel!.id, undefined)}
            >
              <Icon name="button-close" size={12} />
            </button>
          </div>
        )}
      </Show>
      <Show when={draft().files.length > 0 || uploading() > 0}>
        <div class="mb-1.5 flex flex-wrap gap-1.5">
          <For each={draft().files} keyed={(f) => f.id}>
            {(f) => (
              <span class="flex items-center gap-1.5 rounded-md border border-line bg-page py-1 pr-1 pl-2 text-xs">
                <Icon name="button-folder" size={12} />
                <span class="max-w-48 truncate">{f().name}</span>
                <button
                  type="button"
                  class="cursor-pointer rounded p-0.5 hover:bg-hover"
                  aria-label={chatWording().composer.removeFile(f().name)}
                  onClick={() => drafts.drop(props.channel!.id, f().id)}
                >
                  <Icon name="button-close" size={10} />
                </button>
              </span>
            )}
          </For>
          <Show when={uploading() > 0}>
            <span class="px-1 py-1 text-xs text-muted">{chatWording().composer.uploading}</span>
          </Show>
        </div>
      </Show>
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
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files ?? [])];
            if (files.length === 0) return;
            e.preventDefault();
            void attach(files);
          }}
          class="block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base outline-none [field-sizing:content] placeholder:text-faint"
        />
        <div class="flex items-center gap-1 px-2 pb-2">
          <Show when={props.channel?.type !== "direct"}>
            <span class="text-xs text-faint">{chatWording().composer.mention}</span>
          </Show>
          <span class="flex-1" />
          <input
            ref={(el) => (picker = el)}
            type="file"
            multiple
            class="hidden"
            aria-hidden="true"
            tabindex={-1}
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = "";
              void attach(files);
            }}
          />
          <button
            type="button"
            onClick={() => picker?.click()}
            disabled={!props.channel}
            aria-label={chatWording().composer.attach}
            title={chatWording().composer.attach}
            class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-hover disabled:cursor-default disabled:opacity-40"
          >
            <Icon name="button-folder" size={16} />
          </button>
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
