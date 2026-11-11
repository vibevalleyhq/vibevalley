import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Channel, CronView } from "@vibevalley/protocol";

import { aria, useNow } from "#/base/dom.tsx";
import { chatPath, sessionThreadOf } from "#/features/channel/model/places.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { useRouter } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Empty } from "#/ui/layout.tsx";

import { HelperFace, PhaseGlyph, phaseText } from "./presence";

const styles = stylex.create({
  sessionsDiv: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    padding: "0.75rem",
  },
  cronCardDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.75rem",
    borderRadius: "var(--radius-lg)",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    padding: "0.75rem",
  },
  cronCardDivPrimary: {
    borderStyle: "solid",
  },
  cronCardDivSecondary: {
    borderStyle: "dashed",
  },
  cronCardIcon: {
    marginTop: "0.125rem",
  },
  sessionsDiv2: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  sessionsDiv3: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    overflowY: "auto",
    padding: "1rem",
  },
  sessionsSpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  sessionsSpan2: {
    fontWeight: "var(--font-weight-semibold)",
  },
  sessionsSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  sessionsSpan4: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  sessionsSpan5: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  cronCardSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  cronCardDiv2: {
    display: "flex",
    gap: "0.5rem",
  },
});

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
      <div {...stylex.attrs(styles.sessionsDiv3)}>
        <For each={sessions()}>
          {(h) => {
            const thread = () => sessionThreadOf(core()?.chat, h);
            return (
              <div {...stylex.attrs(styles.sessionsDiv)}>
                <HelperFace agent={h.agent} runtime={h.runtime} size={36} />
                <div {...stylex.attrs(styles.sessionsDiv2)}>
                  <span {...stylex.attrs(styles.sessionsSpan)}>
                    <span {...stylex.attrs(styles.sessionsSpan2)}>{h.name}</span>
                    <span {...stylex.attrs(styles.sessionsSpan3)}>
                      {"  "}@{h.id} {h.repo ?? ""}
                      {h.branch ? ` · ${h.branch}` : ""}
                    </span>
                  </span>
                  <span {...stylex.attrs(styles.sessionsSpan)}>{h.brief}</span>
                  <span {...stylex.attrs(styles.sessionsSpan4)}>
                    <PhaseGlyph phase={h.phase} />
                    <span {...stylex.attrs(styles.sessionsSpan5)}>{phaseText(h, now())}</span>
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
      <div {...stylex.attrs(styles.sessionsDiv3)}>
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
      // Only an orchestrator has the cron tool, so an agent's cron is the orchestrator's.
      ...(props.s.by === "agent" ? [t("web.channel.crons.byOrchestrator")] : []),
    ].join(" · ");
  return (
    <div
      data-testid="cron"
      data-key={props.s.id}
      {...stylex.attrs(styles.cronCardDiv, !(props.s.enabled || props.s.pending) ? styles.cronCardDivSecondary : styles.cronCardDivPrimary)}
      aria-label={t("web.channel.crons.label", { name: props.s.name })}
    >
      <Icon name="clock" size={20} styles={[styles.cronCardIcon]} />
      <div {...stylex.attrs(styles.sessionsDiv2)}>
        <span {...stylex.attrs(styles.cronCardSpan)}>
          <span {...stylex.attrs(styles.sessionsSpan2)}>{props.s.name}</span>
          <span {...stylex.attrs(styles.sessionsSpan3)}>
            {"  "}
            {meta()}
          </span>
        </span>
        <span {...stylex.attrs(styles.cronCardSpan)}>{props.s.text}</span>
      </div>
      <Show
        when={props.s.pending}
        fallback={
          <div {...stylex.attrs(styles.cronCardDiv2)}>
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
        <div {...stylex.attrs(styles.cronCardDiv2)}>
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
