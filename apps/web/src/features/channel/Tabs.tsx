import { t } from "@vibevalley/i18n";

import { createEffect, createSignal, For, Show } from "solid-js";
import type { Channel, Recurrence } from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import { chatPath, jobThreadOf, phaseText } from "./rules";
import { toast } from "../../ui/toasts";
import { aria, useNow } from "../../base/util";
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
    <Show when={sessions().length > 0} fallback={<Empty icon="issues">{t("web.channel.jobs.empty")}</Empty>}>
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
                      {t("web.channel.jobs.thread")}
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
    <Show when={recurrences().length > 0} fallback={<Empty icon="clock">{t("web.channel.recurrences.empty")}</Empty>}>
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
      props.s.pending ? (props.s.nextText ?? "") : t("web.channel.recurrences.next", { next: props.s.nextText ?? "" }),
      ...(props.s.agent ? [t("web.channel.recurrences.direct", { agent: props.s.agent })] : []),
      ...(props.s.by === "orchestrator" ? [t("web.channel.recurrences.byOrchestrator")] : []),
    ].join(" · ");
  return (
    <div
      data-testid="recurrence"
      data-key={props.s.id}
      class={[card, "flex items-start gap-3", { "opacity-60": !(props.s.enabled || props.s.pending) }]}
      aria-label={t("web.channel.recurrences.label", { name: props.s.name })}
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
            <Button
              tone={props.s.enabled ? "primary" : "plain"}
              data-testid="recurrence-toggle"
              aria-pressed={aria(props.s.enabled)}
              onClick={() => void setEnabled(!props.s.enabled)}
            >
              {props.s.enabled ? t("web.channel.recurrences.on") : t("web.channel.recurrences.off")}
            </Button>
            <Show
              when={deleting()}
              fallback={
                <Button
                  icon="delete"
                  data-testid="delete"
                  title={t("web.channel.recurrences.remove")}
                  aria-label={t("web.channel.recurrences.removeWhich", { name: props.s.name })}
                  onClick={() => setDeleting(true)}
                />
              }
            >
              <Button tone="danger" data-testid="delete-sure" onPointerDown={(e) => e.stopPropagation()} onClick={() => void remove()}>
                {t("web.channel.recurrences.sure")}
              </Button>
            </Show>
          </div>
        }
      >
        <div class="flex gap-2">
          <Button
            tone="primary"
            icon="check"
            aria-label={t("web.channel.recurrences.approveWhich", { name: props.s.name })}
            onClick={() => void setEnabled(true)}
          >
            {t("web.channel.recurrences.approve")}
          </Button>
          <Button icon="cross" aria-label={t("web.channel.recurrences.refuseWhich", { name: props.s.name })} onClick={() => void remove()}>
            {t("web.channel.recurrences.refuse")}
          </Button>
        </div>
      </Show>
    </div>
  );
}
