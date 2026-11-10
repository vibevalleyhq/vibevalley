import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, Show, untrack } from "solid-js";

import { Combobox } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";
import { channelOf } from "@vibevalley/protocol/rules";

import { autofocus } from "#/base/dom.tsx";
import { notesSearch, noteTargets, pkmHref, usePkmVault } from "#/features/pkm/index.ts";
import { useWorkAgents } from "#/infra/agents.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { ready } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { defineAtom } from "#/state/atom.ts";
import { createAct } from "#/ui/act.ts";
import { Dialog } from "#/ui/Dialog.tsx";

import { chatPath, type SwitchTarget, switchTargets } from "./places";
import { Count } from "./presence";

const styles = stylex.create({
  switcherBodyComboboxInput: {
    height: "calc(var(--spacing) * 10)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: {
      default: "var(--color-line)",
      ":focus": "var(--color-focus)",
    },
    backgroundColor: "var(--color-page)",
    paddingInline: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    outlineStyle: "none",
  },
  switcherBodyComboboxPopup: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  switcherBodyComboboxEmpty: {
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  switcherBodyComboboxItem: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    backgroundColor: {
      default: null,
      ":is([data-highlighted])": "var(--color-selected)",
    },
  },
  switcherBodySpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  switcherBodySpanTone: {
    fontWeight: "var(--font-weight-semibold)",
  },
  switcherBodySpanAlt: {},
  switcherBodyDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  switcherBodySpan2: {
    flexShrink: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
});

const shown = defineAtom(false);

/** One switcher for the page: the shell's Ctrl+K and the chat sidebar's bar open the same one. */
export const switcher = { show: () => shown.set(true), toggle: () => shown.update((s) => !s) };

/** Ctrl+K: a channel, thread or direct channel by its name; a profile not yet talked with gets its direct channel. */
export function QuickSwitcher() {
  return (
    <Dialog open={shown.get()} onClose={() => shown.set(false)} title={t("web.channel.switcher.title")} testid="switcher">
      <SwitcherBody onClose={() => shown.set(false)} />
    </Dialog>
  );
}

function SwitcherBody(props: { onClose: () => void }) {
  const core = useCore();
  const router = useRouter();
  const profiles = useWorkAgents();
  const [query, setQuery] = createSignal("");
  const vault = usePkmVault();
  // The notes after the chat: the pages whose title has the words, and a last line to search inside them.
  const targets = createMemo((): SwitchTarget[] => {
    const typed = query().trim();
    const notes = noteTargets(ready(vault, undefined)?.pages ?? [], typed).map((n): SwitchTarget => ({
      kind: "note",
      id: n.slug,
      label: n.label,
      hint: t("web.channel.switcher.note", { tier: t(`web.pkm.tier.${n.tier}`) }),
      unread: 0,
      at: 0,
    }));
    return [
      ...switchTargets(core()?.chat, query(), { issues: core()?.issues ?? [], sessions: core()?.sessions ?? [], profiles: profiles() }),
      ...notes,
      ...(typed ? [{ kind: "notes", id: typed, label: t("web.channel.switcher.searchNotes", { q: typed }), hint: "", unread: 0, at: 0 } as const] : []),
    ];
  });
  // Made here, not in go: the dialog closes as the user picks, and the act outlives it.
  const act = createAct();
  const go = (t: SwitchTarget) => {
    untrack(() => props.onClose)();
    if (t.kind === "note") return router.navigate(pkmHref(t.id));
    if (t.kind === "notes") return notesSearch.open(t.id);
    if (t.kind !== "profile") return router.navigate(chatPath(channelOf(untrack(core)?.chat, t.id)));
    const agent = t.id;
    void act.run(async () => router.navigate(`/chat/${await api.channel.direct.create({ agent })}`));
  };
  return (
    <Combobox.Root inline autoHighlight inputValue={query()} onInputValueChange={setQuery}>
      <div {...stylex.attrs(styles.switcherBodyDiv)}>
        <Combobox.Input
          ref={autofocus()}
          data-testid="switcher-input"
          aria-label={t("web.channel.switcher.title")}
          placeholder={t("web.channel.switcher.hint")}
          {...stylex.attrs(styles.switcherBodyComboboxInput)}
        />
        <Combobox.Popup aria-label={t("web.channel.switcher.title")} {...stylex.attrs(styles.switcherBodyComboboxPopup)}>
          <Combobox.Empty {...stylex.attrs(styles.switcherBodyComboboxEmpty)}>{t("web.channel.switcher.none")}</Combobox.Empty>
          <For each={targets()} keyed={(t) => `${t.kind}:${t.id}`}>
            {(t) => (
              <Combobox.Item
                value={`${t().kind}:${t().id}`}
                data-key={t().id}
                data-kind={t().kind}
                onClick={(e) => {
                  // Going there closes the switcher; the input keeps what was typed until then.
                  e.preventDefault();
                  go(t());
                }}
                {...stylex.attrs(styles.switcherBodyComboboxItem)}
              >
                <span
                  {...stylex.attrs(
                    styles.switcherBodySpan,
                    t().unread > 0 ? styles.switcherBodySpanTone : styles.switcherBodySpanAlt,
                  )}
                >
                  {t().label}
                </span>
                <span {...stylex.attrs(styles.switcherBodySpan2)}>{t().hint}</span>
                <Show when={t().unread > 0}>
                  <Count n={t().unread} />
                </Show>
              </Combobox.Item>
            )}
          </For>
        </Combobox.Popup>
      </div>
    </Combobox.Root>
  );
}
