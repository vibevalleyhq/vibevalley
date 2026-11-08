import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Channel, CronView } from "@vibevalley/protocol";

import { aria, useNow } from "#/base/dom.tsx";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { useRouter } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Empty } from "#/ui/layout.tsx";

import { chatPath, sessionThreadOf } from "./places";
import { HelperFace, PhaseGlyph, phaseText } from "./presence";

const viewStyles = stylex.create({
  sessionsDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
    overflowY: "auto",
    padding: "calc(var(--spacing) * 4)",
  },
  sessionsSpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  sessionsSpan2: {
    fontWeight: "var(--font-weight-semibold)",
  },
  sessionsSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  sessionsSpan4: {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  sessionsSpan5: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  cronCardSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  cronCardDiv: {
    display: "flex",
    gap: "calc(var(--spacing) * 2)",
  },
});

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
      <div {...stylex.attrs(viewStyles.sessionsDiv)}>
        <For each={sessions()}>
          {(h) => {
            const thread = () => sessionThreadOf(core()?.chat, h);
            return (
              <div class={[card, "flex items-center gap-3"]}>
                <HelperFace agent={h.agent} runtime={h.runtime} size={36} />
                <div class="flex min-w-0 flex-1 flex-col">
                  <span {...stylex.attrs(viewStyles.sessionsSpan)}>
                    <span {...stylex.attrs(viewStyles.sessionsSpan2)}>{h.name}</span>
                    <span {...stylex.attrs(viewStyles.sessionsSpan3)}>
                      {"  "}@{h.id} {h.repo ?? ""}
                      {h.branch ? ` · ${h.branch}` : ""}
                    </span>
                  </span>
                  <span {...stylex.attrs(viewStyles.sessionsSpan)}>{h.brief}</span>
                  <span {...stylex.attrs(viewStyles.sessionsSpan4)}>
                    <PhaseGlyph phase={h.phase} />
                    <span {...stylex.attrs(viewStyles.sessionsSpan5)}>{phaseText(h, now())}</span>
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
      <div {...stylex.attrs(viewStyles.sessionsDiv)}>
        <For each={crons()}>{(s) => <CronCard s={s} />}</For>
      </div>
    </Show>
  );
}

export function CronCard(props: { s: CronView }) {
  const [deleting, setDeleting] = createSignal(false);
  const act = createAct();
  const setEnabled = (enabled: boolean) => {
    const id = props.s.id;
    return act.run(() => api.cron.update({ id, enabled }));
  };
  const remove = () => {
    const id = props.s.id;
    return act.run(() => api.cron.delete({ id }));
  };
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
        <span {...stylex.attrs(viewStyles.cronCardSpan)}>
          <span {...stylex.attrs(viewStyles.sessionsSpan2)}>{props.s.name}</span>
          <span {...stylex.attrs(viewStyles.sessionsSpan3)}>
            {"  "}
            {meta()}
          </span>
        </span>
        <span {...stylex.attrs(viewStyles.cronCardSpan)}>{props.s.text}</span>
      </div>
      <Show
        when={props.s.pending}
        fallback={
          <div {...stylex.attrs(viewStyles.cronCardDiv)}>
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
        <div {...stylex.attrs(viewStyles.cronCardDiv)}>
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
