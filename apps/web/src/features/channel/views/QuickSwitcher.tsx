import { createMemo, createSignal, For, Show, untrack } from "solid-js";

import { Combobox } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";
import { channelOf } from "@vibevalley/protocol/rules";

import { autofocus } from "#/base/dom.tsx";
import { chatPath, type SwitchTarget, switchTargets } from "#/features/channel/model/places.ts";
import { notesSearch, noteTargets, pkmHref, usePkmVault } from "#/features/pkm/index.ts";
import { useWorkAgents } from "#/infra/agents.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { ready } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { defineAtom } from "#/state/atom.ts";
import { createAct } from "#/ui/act.ts";
import { Dialog } from "#/ui/Dialog.tsx";

import { Count } from "./presence";

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
      <div class="flex flex-col gap-2">
        <Combobox.Input
          ref={autofocus()}
          data-testid="switcher-input"
          aria-label={t("web.channel.switcher.title")}
          placeholder={t("web.channel.switcher.hint")}
          class="h-10 rounded-md border border-line focus:border-focus bg-page px-3 text-base outline-none"
        />
        <Combobox.Popup aria-label={t("web.channel.switcher.title")} class="flex flex-col gap-0.5">
          <Combobox.Empty class="px-2 py-2 text-sm text-muted">{t("web.channel.switcher.none")}</Combobox.Empty>
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
                class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 data-highlighted:bg-selected"
              >
                <span class={["min-w-0 flex-1 truncate text-sm", t().unread > 0 ? "font-semibold" : ""]}>{t().label}</span>
                <span class="shrink-0 truncate text-xs text-muted">{t().hint}</span>
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
