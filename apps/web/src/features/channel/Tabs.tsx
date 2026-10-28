import { chatWording } from "./words";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { Channel, Recurrence } from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import { chatPath, jobThreadOf, phaseText } from "./rules";
import { toast } from "../../ui/toasts";
import { useNow } from "../../base/util";
import { useRouter } from "../../base/router";
import { useCore } from "../../base/frame";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { Empty, HelperFace, PhaseGlyph } from "./bits";

const card = "rounded-lg border border-line bg-page p-3";

/** The sessions arranged in this channel; the general holds those arranged in no channel. */
export function Jobs(props: { channel: Channel }) {
  const core = useCore();
  const router = useRouter();
  const now = useNow();
  const sessions = () => (core()?.sessions ?? []).filter((h) => (h.channel ? h.channel === props.channel.id : !!props.channel.default));
  return (
    <Show when={sessions().length > 0} fallback={<Empty icon="issues">{chatWording().jobs.empty}</Empty>}>
      <div class="flex flex-col gap-3 overflow-y-auto p-4">
        <For each={sessions()}>
          {(h) => {
            const thread = () => jobThreadOf(core()?.chat, h);
            return (
              <div class={[card, "flex items-center gap-3"]}>
                <HelperFace agent={h.agent} runtime={h.runtime} size={36} />
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
                  {(shown) => (
                    <Button icon="thread" onClick={() => router.navigate(chatPath(shown()))}>
                      {chatWording().jobs.thread}
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

export function Recurrences(props: { channel: Channel }) {
  const core = useCore();
  const recurrences = () => (core()?.recurrences ?? []).filter((s) => s.channel === props.channel.id);
  return (
    <Show when={recurrences().length > 0} fallback={<Empty icon="clock">{chatWording().recurrences.empty}</Empty>}>
      <div class="flex flex-col gap-3 overflow-y-auto p-4">
        <For each={recurrences()}>{(s) => <RecurrenceCard s={s} />}</For>
      </div>
    </Show>
  );
}

function RecurrenceCard(props: { s: Recurrence }) {
  const [deleting, setDeleting] = createSignal(false);
  const act = (p: Promise<void>) => p.catch((e) => toast(reasonOf(e), "bad"));
  const setEnabled = (enabled: boolean) => act(api.recurrence.update({ id: props.s.id, enabled }));
  const remove = () => act(api.recurrence.delete({ id: props.s.id }));
  // The second press deletes; a press anywhere else takes the first back.
  createEffect(deleting, (on) => {
    if (!on) return;
    const away = () => setDeleting(false);
    const timer = setTimeout(() => document.addEventListener("pointerdown", away, { once: true }));
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", away);
    };
  });
  const meta = () =>
    [
      props.s.whenText ?? "",
      props.s.pending ? (props.s.nextText ?? "") : chatWording().recurrences.next(props.s.nextText ?? ""),
      ...(props.s.agent ? [chatWording().recurrences.direct(props.s.agent)] : []),
      ...(props.s.by === "orchestrator" ? [chatWording().recurrences.byOrchestrator] : []),
    ].join(" · ");
  return (
    <div
      class={[card, "flex items-start gap-3", { "opacity-60": !(props.s.enabled || props.s.pending) }]}
      aria-label={chatWording().recurrences.label(props.s.name)}
    >
      <Icon name="clock" size={20} class="mt-0.5" />
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
              {props.s.enabled ? chatWording().recurrences.on : chatWording().recurrences.off}
            </Button>
            <Show
              when={deleting()}
              fallback={
                <Button
                  icon="delete"
                  title={chatWording().recurrences.remove}
                  aria-label={chatWording().recurrences.removeWhich(props.s.name)}
                  onClick={() => setDeleting(true)}
                />
              }
            >
              <Button tone="danger" onPointerDown={(e) => e.stopPropagation()} onClick={() => void remove()}>
                {chatWording().recurrences.sure}
              </Button>
            </Show>
          </div>
        }
      >
        <div class="flex gap-2">
          <Button tone="primary" icon="check" aria-label={chatWording().recurrences.approveWhich(props.s.name)} onClick={() => void setEnabled(true)}>
            {chatWording().recurrences.approve}
          </Button>
          <Button icon="cross" aria-label={chatWording().recurrences.refuseWhich(props.s.name)} onClick={() => void remove()}>
            {chatWording().recurrences.refuse}
          </Button>
        </div>
      </Show>
    </div>
  );
}
