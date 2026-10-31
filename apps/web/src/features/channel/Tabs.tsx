import { createEffect, createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Channel, CronView } from "@vibevalley/protocol";

import { api, reasonOf } from "@/base/api";
import { useCore } from "@/base/frame";
import { useRouter } from "@/base/router";
import { aria, useNow } from "@/base/util";
import { Button } from "@/ui/Button";
import { Empty } from "@/ui/Empty";
import { Icon } from "@/ui/Icon";
import { toast } from "@/ui/toasts";

import { HelperFace, PhaseGlyph } from "./bits";
import { chatPath } from "./places";
import { phaseText } from "./presence";
import { sessionThreadOf } from "./threads";

const card = "rounded-lg border border-line bg-page p-3";

/** The sessions arranged in this channel; the general holds those arranged in no channel. */
export function Sessions(props: { channel: Channel }) {
  const core = useCore();
  const router = useRouter();
  const now = useNow();
  const sessions = () => (core()?.sessions ?? []).filter((h) => (h.channel ? h.channel === props.channel.id : props.channel.default));
  return (
    <Show
      when={sessions().length > 0}
      fallback={
        <Empty testid="tab-empty" icon="issues">
          {t("web.channel.issues.empty")}
        </Empty>
      }
    >
      <div class="flex flex-col gap-3 overflow-y-auto p-4">
        <For each={sessions()}>
          {(h) => {
            const thread = () => sessionThreadOf(core()?.chat, h);
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
                      {t("web.channel.issues.thread")}
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

export function Crons(props: { channel: Channel }) {
  const core = useCore();
  const crons = () => (core()?.crons ?? []).filter((s) => s.channel === props.channel.id);
  return (
    <Show
      when={crons().length > 0}
      fallback={
        <Empty testid="tab-empty" icon="clock">
          {t("web.channel.crons.empty")}
        </Empty>
      }
    >
      <div class="flex flex-col gap-3 overflow-y-auto p-4">
        <For each={crons()}>{(s) => <CronCard s={s} />}</For>
      </div>
    </Show>
  );
}

export function CronCard(props: { s: CronView }) {
  const [deleting, setDeleting] = createSignal(false);
  const act = (p: Promise<void>) => p.catch((e) => toast(reasonOf(e), "bad"));
  const setEnabled = (enabled: boolean) => act(api.cron.update({ id: props.s.id, enabled }));
  const remove = () => act(api.cron.delete({ id: props.s.id }));
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
      props.s.whenText,
      props.s.pending ? props.s.nextText : t("web.channel.crons.next", { next: props.s.nextText }),
      ...(props.s.agent ? [t("web.channel.crons.direct", { agent: props.s.agent })] : []),
      ...(props.s.by === "orchestrator" ? [t("web.channel.crons.byOrchestrator")] : []),
    ].join(" · ");
  return (
    <div
      data-testid="cron"
      data-key={props.s.id}
      class={[card, "flex items-start gap-3", { "border-dashed": !(props.s.enabled || props.s.pending) }]}
      aria-label={t("web.channel.crons.label", { name: props.s.name })}
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
              data-testid="cron-toggle"
              aria-pressed={aria(props.s.enabled)}
              onClick={() => void setEnabled(!props.s.enabled)}
            >
              {props.s.enabled ? t("web.channel.crons.on") : t("web.channel.crons.off")}
            </Button>
            <Show
              when={deleting()}
              fallback={
                <Button
                  icon="delete"
                  data-testid="delete"
                  title={t("web.channel.crons.remove")}
                  aria-label={t("web.channel.crons.removeWhich", { name: props.s.name })}
                  onClick={() => setDeleting(true)}
                />
              }
            >
              <Button tone="danger" data-testid="delete-sure" onPointerDown={(e) => e.stopPropagation()} onClick={() => void remove()}>
                {t("web.channel.crons.sure")}
              </Button>
            </Show>
          </div>
        }
      >
        <div class="flex gap-2">
          <Button tone="primary" icon="check" aria-label={t("web.channel.crons.approveWhich", { name: props.s.name })} onClick={() => void setEnabled(true)}>
            {t("web.channel.crons.approve")}
          </Button>
          <Button icon="cross" aria-label={t("web.channel.crons.refuseWhich", { name: props.s.name })} onClick={() => void remove()}>
            {t("web.channel.crons.refuse")}
          </Button>
        </div>
      </Show>
    </div>
  );
}
