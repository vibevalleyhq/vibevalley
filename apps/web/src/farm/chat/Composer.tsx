import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Channel } from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { chatMarks, chatSay, createComposer, drafts, threadOwnerOf, useReplying } from "#/features/channel/index.ts";
import { DictationButton } from "#/features/voice/index.ts";
import { useAgent } from "#/infra/agents.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { useRouter } from "#/infra/router.ts";
import { useIntents } from "#/state/intent.ts";
import { setPick, usePrefs } from "#/state/prefs.ts";
import { AgentFace } from "#/ui/Face.tsx";
import { createPixelAct, SpriteIcon, toasts } from "#/ui/pixel/index.ts";
import { typeMarks } from "#/ui/typedMarks.ts";

const styles = stylex.create({
  farmComposerDiv: {
    position: "absolute",
    right: "calc(var(--spacing) * 2)",
    bottom: "100%",
    left: "calc(var(--spacing) * 2)",
    marginBottom: "var(--spacing)",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-cream-300)",
    backgroundColor: "var(--color-cream-50)",
    paddingBlock: "var(--spacing)",
    boxShadow: "var(--shadow-px)",
  },
  farmComposerButton: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    textAlign: "left",
    fontSize: "12px",
  },
  farmComposerButtonPrimary: {
    backgroundColor: null,
  },
  farmComposerButtonSecondary: {
    backgroundColor: {
      default: "var(--color-px-leaf-hover)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-leaf-300) 40%, transparent)",
    },
  },
  pickChipSpan: {
    marginRight: "var(--spacing)",
    display: "flex",
    height: "calc(var(--spacing) * 8)",
    flexShrink: "0",
    alignItems: "center",
    gap: "var(--spacing)",
    backgroundColor: "var(--color-cream-200)",
    paddingRight: "var(--spacing)",
    paddingLeft: "calc(var(--spacing) * .5)",
  },
  pickChipSpan2: {
    maxWidth: "calc(var(--spacing) * 20)",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "12px",
    color: "var(--color-bark-800)",
  },
  unpick: {
    display: "flex",
    height: "calc(var(--spacing) * 6)",
    width: "calc(var(--spacing) * 6)",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-300)",
      },
    },
  },
  composer: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-cream-200)",
    padding: "calc(var(--spacing) * 1.5)",
  },
  replying: {
    marginBottom: "var(--spacing)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
  },
  farmComposerSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    color: "var(--color-bark-500)",
  },
  cancelReply: {
    cursor: "pointer",
    padding: "calc(var(--spacing) * .5)",
  },
  farmComposerDiv2: {
    position: "relative",
    display: "flex",
    alignItems: "flex-end",
    gap: "calc(var(--spacing) * 1.5)",
  },
  farmComposerSpan2: {
    color: "var(--color-bark-900)",
  },
  farmComposerSpan3: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    color: "var(--color-bark-500)",
  },
  farmComposerDiv22: {
    display: "flex",
    minHeight: "calc(var(--spacing) * 11)",
    minWidth: "0",
    flex: "1",
    alignItems: "center",
    backgroundColor: "var(--color-cream-50)",
    paddingInline: "var(--spacing)",
    boxShadow: "inset 0 0 0 2px var(--color-cream-300)",
  },
  composerInput: {
    maxHeight: "calc(var(--spacing) * 24)",
    minWidth: "0",
    flex: "1",
    resize: "none",
    backgroundColor: "transparent",
    paddingInline: "var(--spacing)",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "calc(var(--spacing) * 4)",
    color: {
      default: "var(--color-bark-900)",
      "::placeholder": "var(--color-bark-400)",
    },
    outlineStyle: "none",
  },
  stop: {
    cursor: "pointer",
    padding: "var(--spacing)",
  },
  send: {
    cursor: "pointer",
    padding: "var(--spacing)",
    opacity: {
      default: null,
      ":disabled": ".4",
    },
  },
});

/** Who the next line goes to, with a button to stop picking. */
function PickChip(props: { named: boolean }) {
  const pick = usePrefs((p) => p.pick);
  const agent = useAgent(pick);
  return (
    <Show when={pick() !== "auto" && agent()?.enabled === true ? agent() : undefined}>
      {(a) => (
        <span {...stylex.attrs(styles.pickChipSpan)} title={t("web.farm.chat.sendTo", { name: a().name })}>
          <AgentFace agentId={a().id} runtime={a().runtime} look={a().look} size={26} />
          <Show when={props.named}>
            <span {...stylex.attrs(styles.pickChipSpan2)}>{t("web.farm.chat.sendTo", { name: a().name })}</span>
          </Show>
          <button
            type="button"
            data-testid="unpick"
            aria-label={t("web.farm.chat.anyone")}
            onClick={() => setPick("auto")}
            {...stylex.attrs(styles.unpick)}
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
  const placeholder = () => {
    const threadOwner = owner();
    return props.thread
      ? threadOwner
        ? t("web.farm.chat.inThread", { name: threadOwner.name })
        : t("web.farm.chat.inThreadAnyone")
      : props.channel?.type === "direct"
        ? t("web.farm.chat.toOrchestratorAlone")
        : t("web.farm.chat.toOrchestrator");
  };

  const router = useRouter();

  const replying = useReplying(() => props.channel?.id);
  const box = createComposer(core, () => input, {
    target: () => {
      const reply = replying();
      const agent = props.thread || pick() === "auto" ? undefined : pick();
      return { id: props.channel?.id ?? "", ...(agent ? { agent } : {}), ...(reply ? { replyTo: reply.number } : {}) };
    },
    says: useIntents(chatSay),
    failed: (reason) => props.onProblem(t("web.farm.chat.notSent", { why: reason })),
    told: (say) => toasts.add({ title: say }),
    opened: (path) => router.navigate(path),
    edited: () => props.onProblem(undefined),
    sent: () => {
      const id = props.channel?.id;
      if (id) drafts.reply(id, undefined);
    },
  });
  const stopping = createPixelAct();
  const stop = () => {
    const agent = box.here();
    return stopping.run(() => api.orchestrator.stop({ agent }));
  };

  return (
    <div data-testid="composer" data-key={props.channel?.id} {...stylex.attrs(styles.composer)}>
      <Show when={replying()}>
        {(m) => (
          <div data-testid="replying" data-key={m().number} {...stylex.attrs(styles.replying)}>
            <span {...stylex.attrs(styles.farmComposerSpan)}>
              {m().text ? t("web.farm.chat.replyToText", { name: m().name, text: m().text }) : t("web.farm.chat.replyTo", { name: m().name })}
            </span>
            <button
              type="button"
              data-testid="cancel-reply"
              aria-label={t("web.farm.chat.actions.cancelReply")}
              onClick={() => drafts.reply(m().channel, undefined)}
              {...stylex.attrs(styles.cancelReply)}
            >
              <SpriteIcon name="button-close" size={12} />
            </button>
          </div>
        )}
      </Show>
      <div {...stylex.attrs(styles.farmComposerDiv2)}>
        <Show when={box.offered().length > 0}>
          <div {...stylex.attrs(styles.farmComposerDiv)} role="listbox" aria-label={t("web.farm.chat.who")}>
            <For each={box.offered()} keyed={(n) => n.token}>
              {(n, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={aria(i() === box.active())}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => box.choose(n())}
                  {...stylex.attrs(
                    styles.farmComposerButton,
                    i() === box.active() ? styles.farmComposerButtonSecondary : styles.farmComposerButtonPrimary,
                  )}
                >
                  <span {...stylex.attrs(styles.farmComposerSpan2)}>{n().name}</span>
                  <span {...stylex.attrs(styles.farmComposerSpan3)}>{n().note}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div {...stylex.attrs(styles.farmComposerDiv22)}>
          <Show when={!props.thread}>
            <PickChip named />
          </Show>
          <textarea
            ref={(el) => (input = el)}
            rows={1}
            value={box.text()}
            data-testid="composer-input"
            placeholder={placeholder()}
            aria-label={placeholder()}
            onInput={(e) => {
              if (!e.isComposing && typeMarks(e.currentTarget, chatMarks)) return;
              box.edit(e.currentTarget.value, e.currentTarget.selectionStart);
            }}
            onKeyUp={box.follow}
            onClick={box.follow}
            onKeyDown={box.onKey}
            {...stylex.attrs(styles.composerInput)}
          />
          <Show when={box.stoppable()}>
            <button
              type="button"
              data-testid="stop"
              aria-label={t("web.farm.chat.stop")}
              title={t("web.farm.chat.stopHint")}
              onClick={() => void stop()}
              {...stylex.attrs(styles.stop)}
            >
              <SpriteIcon name="button-stop" size={24} />
            </button>
          </Show>
          <DictationButton field={() => input} value={box.text()} onValue={box.edit} />
          <button
            type="button"
            data-testid="send"
            aria-label={t("web.farm.chat.send")}
            disabled={!box.canSend()}
            onClick={() => void box.send()}
            {...stylex.attrs(styles.send)}
          >
            <SpriteIcon name="button-send" size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
