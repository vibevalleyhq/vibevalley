import { createEffect, createSignal, For, Show } from "solid-js";
import type { Conversation, Recurrence } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { chatPath, jobThreadOf, phaseText } from "../../rules/chat";
import { toast } from "../../ui/toasts";
import { useNow } from "../../app/util";
import { useRouter } from "../../app/router";
import { useCore } from "../../data/frame";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { Empty, HelperFace, PhaseGlyph } from "./bits";

const card = "rounded-lg border border-line bg-page p-3";

/** The sessions arranged in this channel; the general holds those arranged in no channel. */
export function Jobs(props: { channel: Conversation }) {
  const core = useCore();
  const router = useRouter();
  const now = useNow();
  const sessions = () => (core()?.sessions ?? []).filter((h) => (h.channel ? h.channel === props.channel.id : props.channel.kind === "general"));
  return (
    <Show when={sessions().length > 0} fallback={<Empty icon="icon-tasks">这个频道里还没有活。在聊天里跟管家说一件要做的事，它会派帮工，活就列在这里。</Empty>}>
      <div class="flex flex-col gap-3 overflow-y-auto p-4">
        <For each={sessions()}>
          {(h) => {
            const thread = () => jobThreadOf(core()?.chat, h);
            return (
              <div class={[card, "flex items-center gap-3"]}>
                <HelperFace agent={h.agent} size={36} />
                <div class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate text-sm">
                    <span class="font-semibold">{h.name}</span>
                    <span class="text-xs text-muted">
                      {"  "}@{h.id} {h.project ?? ""}
                      {h.branch ? ` · ${h.branch}` : ""}
                    </span>
                  </span>
                  <span class="truncate text-sm">{h.brief}</span>
                  <span class="flex items-center gap-1 text-xs text-muted">
                    <PhaseGlyph phase={h.phase} />
                    <span class="truncate">{phaseText(h, now())}</span>
                  </span>
                </div>
                <Show when={thread()}>
                  {(t) => (
                    <Button icon="button-thread" onClick={() => router.navigate(chatPath(t()))}>
                      工单串
                    </Button>
                  )}
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

export function Recurrences(props: { channel: Conversation }) {
  const core = useCore();
  const recurrences = () => (core()?.recurrences ?? []).filter((s) => s.channel === props.channel.id);
  return (
    <Show
      when={recurrences().length > 0}
      fallback={<Empty icon="icon-clock">这个频道还没有定时。跟管家说「每天早上九点跑一遍测试」，它会定在这里；到点了频道里出现一条，再派活。</Empty>}
    >
      <div class="flex flex-col gap-3 overflow-y-auto p-4">
        <For each={recurrences()}>{(s) => <RecurrenceCard s={s} />}</For>
      </div>
    </Show>
  );
}

function RecurrenceCard(props: { s: Recurrence }) {
  const [deleting, setDeleting] = createSignal(false);
  const act = (p: Promise<void>) => p.catch((e) => toast(reasonOf(e), "bad"));
  const setEnabled = (enabled: boolean) => act(api.recurrence.update({ id: props.s.id, body: { enabled } }));
  const remove = () => act(api.recurrence.delete({ id: props.s.id }));
  // The second press deletes; a press anywhere else takes the first back.
  createEffect(deleting, (on) => {
    if (!on) return;
    const away = () => setDeleting(false);
    const t = setTimeout(() => document.addEventListener("pointerdown", away, { once: true }));
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", away);
    };
  });
  const meta = () =>
    [
      props.s.whenText ?? "",
      props.s.pending ? (props.s.nextText ?? "") : `下次 ${props.s.nextText ?? ""}`,
      ...(props.s.agent ? [`直接派 ${props.s.agent}`] : []),
      ...(props.s.by === "manager" ? ["管家定的"] : []),
    ].join(" · ");
  return (
    <div class={[card, "flex items-start gap-3", { "opacity-60": !(props.s.enabled || props.s.pending) }]} aria-label={`定时「${props.s.name}」`}>
      <Icon name="icon-clock" size={20} class="mt-0.5" />
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="text-sm">
          <span class="font-semibold">{props.s.name}</span>
          <span class="text-xs text-muted">
            {"  "}
            {meta()}
          </span>
        </span>
        <span class="text-sm">{props.s.text}</span>
      </div>
      <Show
        when={props.s.pending}
        fallback={
          <div class="flex gap-2">
            <Button tone={props.s.enabled ? "primary" : "plain"} onClick={() => void setEnabled(!props.s.enabled)}>
              {props.s.enabled ? "开着" : "关着"}
            </Button>
            <Show
              when={deleting()}
              fallback={<Button icon="button-delete" title="删掉" aria-label={`删掉定时「${props.s.name}」`} onClick={() => setDeleting(true)} />}
            >
              <Button tone="danger" onPointerDown={(e) => e.stopPropagation()} onClick={() => void remove()}>
                确定删？
              </Button>
            </Show>
          </div>
        }
      >
        <div class="flex gap-2">
          <Button tone="primary" icon="mark-check" aria-label={`同意定时「${props.s.name}」`} onClick={() => void setEnabled(true)}>
            同意
          </Button>
          <Button icon="mark-cross" aria-label={`不要定时「${props.s.name}」`} onClick={() => void remove()}>
            不要
          </Button>
        </div>
      </Show>
    </div>
  );
}
