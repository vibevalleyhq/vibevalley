import { createMemo, createSignal, For, Show } from "solid-js";
import type { Conversation } from "@vibevalley/protocol";
import { api, newSendKey, reasonOf } from "../../data/api";
import { insertName, type Nameable, nameables, offeredFor, typedName } from "../../rules/chat";
import { toast } from "../../ui/toasts";
import { aria } from "../../app/util";
import { useCore } from "../../data/frame";
import { OrchestratorFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { DictationButton } from "../../voice/DictationButton";
import { HelperFace } from "./bits";

/** 16 random bytes in hex: names one send, so a retry is the message already said, not a second one. */

/** The box for saying a sentence in a conversation: Enter sends, Shift+Enter starts a line, @ names someone. */
export function Composer(props: { conversation: Conversation | undefined; placeholder: string }) {
  const core = useCore();
  let input: HTMLTextAreaElement | undefined;
  const [text, setText] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  const [active, setActive] = createSignal(0);
  const [closed, setClosed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string>();
  // One key per draft: sending the same draft again, after a failure, reuses its key.
  let key: { draft: string; key: string } | undefined;

  const typing = createMemo(() => (closed() ? undefined : typedName(text(), caret())));
  const offered = createMemo(() => {
    const t = typing();
    return t ? offeredFor(nameables(core()?.sessions ?? [], Date.now()), t.query) : [];
  });
  const stoppable = () => core()?.orchestrator === "thinking" || core()?.orchestrator === "speaking";
  const canSend = () => text().trim() !== "" && !busy();

  const edit = (value: string, at: number) => {
    setText(value);
    setCaret(at);
    setActive(0);
    setClosed(false);
    setProblem(undefined);
  };

  const choose = (n: Nameable) => {
    const t = typing();
    if (!t) return;
    const next = insertName(text(), caret(), t.start, n.token);
    edit(next.text, next.caret);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(next.caret, next.caret);
    });
  };

  const send = async () => {
    const said = text().trim();
    if (!said || busy()) return;
    if (key?.draft !== said) key = { draft: said, key: newSendKey() };
    setBusy(true);
    try {
      await api.orchestrator.open();
      await api.channel.say({
        body: { text: said, conversation: props.conversation?.kind === "general" ? undefined : props.conversation?.id, sendKey: key.key },
      });
      key = undefined;
      edit("", 0);
    } catch (e) {
      setProblem(reasonOf(e));
      toast(`没发出去：${reasonOf(e)}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  const stop = () => api.orchestrator.stop().catch((e) => toast(reasonOf(e), "bad"));

  const onKey = (e: KeyboardEvent) => {
    // Enter that picks a word in an input method neither sends nor names.
    if (e.isComposing) return;
    const list = offered();
    if (list.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(list[Math.min(active(), list.length - 1)]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setClosed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  // The caret moves without typing too (arrow keys, a click): the @ menu follows it.
  const follow = (e: Event) => setCaret((e.currentTarget as HTMLTextAreaElement).selectionStart);

  return (
    <div class="border-t border-line px-4 pt-3 pb-4">
      <Show when={offered().length > 0}>
        <div role="listbox" aria-label="叫谁" class="mb-1.5 flex flex-col rounded-lg border border-line bg-page p-1 shadow-float">
          <For each={offered()} keyed={(n) => n.token}>
            {(n, i) => (
              <div
                role="option"
                aria-selected={aria(i() === active())}
                onMouseEnter={() => setActive(i())}
                // Keeps the focus in the input.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(n());
                }}
                class={["flex cursor-pointer items-center gap-2 rounded-md px-2 py-1", { "bg-selected": i() === active() }]}
              >
                <Show when={n().session} fallback={n().name === "管家" ? <OrchestratorFace size={20} /> : <span class="size-5" />}>
                  {(s) => <HelperFace agent={s().agent} size={20} />}
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
          value={text()}
          rows={2}
          aria-label={props.placeholder}
          placeholder={props.placeholder}
          onInput={(e) => edit(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyUp={follow}
          onClick={follow}
          onKeyDown={onKey}
          onBlur={() => setClosed(true)}
          onFocus={() => setClosed(false)}
          class="block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base outline-none [field-sizing:content] placeholder:text-faint"
        />
        <div class="flex items-center gap-1 px-2 pb-2">
          <span class="text-xs text-faint">@ 叫人</span>
          <span class="flex-1" />
          <DictationButton field={() => input} value={text()} onValue={edit} size={16} class="rounded-md hover:bg-hover" />
          <Show when={stoppable()}>
            <button
              type="button"
              onClick={() => void stop()}
              aria-label="叫停管家"
              title="叫管家停下这一轮，派出去的帮工照常干活"
              class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md border border-line text-berry hover:bg-hover"
            >
              <Icon name="button-stop" size={14} />
            </button>
          </Show>
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend()}
            aria-label="发送"
            title="回车发送 · Shift+回车换行"
            class={[
              "inline-flex size-7 cursor-pointer items-center justify-center rounded-md border disabled:cursor-default",
              canSend() ? "border-accent bg-accent hover:bg-leaf" : "border-transparent opacity-50",
            ]}
          >
            <Icon name="button-send" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
