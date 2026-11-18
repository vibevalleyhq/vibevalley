// Ported from VibeValley apps/web/src/features/channel/views/QuickSwitcher.tsx:
// base-ui's inline Combobox becomes nsh/base's Command (its own search field,
// the keys, the highlight), fed the same switchTargets, then the notes whose
// title has the words and a last line to search inside them.
import { signal, Text, untracked, View } from "nsh";
import { Command } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { channelOf } from "@vibevalley/protocol/rules";

import { useWorkAgents } from "../../../infra/agents";
import { api } from "../../../infra/api";
import { useCore } from "../../../infra/frame";
import { ready } from "../../../infra/query";
import { useRouter } from "../../../infra/router";
import { defineAtom } from "../../../state/atom";
import { createAct } from "../../../ui/act";
import { Dialog } from "../../../ui/Dialog";
import { notesSearch, noteTargets, pkmHref, usePkmVault } from "../../pkm";
import { chatPath, type SwitchTarget, switchTargets } from "../model/places";
import { Count } from "./presence";

const shown = defineAtom(false);

/** One switcher for the page: the shell's Ctrl+K and the chat sidebar's bar open the same one. */
export const switcher = { show: () => shown.set(true), toggle: () => shown.update((s) => !s) };

/** Ctrl+K: a channel, thread or direct channel by its name; a profile not yet talked with gets its direct channel. */
export function QuickSwitcher() {
  return (
    <Dialog open={shown.get()} onClose={() => shown.set(false)} title={t("web.channel.switcher.title")} testid="switcher">
      <If when={shown.get()}>
        <SwitcherBody onClose={() => shown.set(false)} />
      </If>
    </Dialog>
  );
}

const keyOf = (s: SwitchTarget) => `${s.kind}:${s.id}`;

function SwitcherBody(props: { onClose: () => void }) {
  const core = useCore();
  const router = useRouter();
  const profiles = useWorkAgents();
  const query = signal("");
  const vault = usePkmVault();
  const targets = (): SwitchTarget[] => {
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
  };
  // Made here, not in go: the dialog closes as the user picks, and the act outlives it.
  const act = createAct();
  const go = (to: SwitchTarget) => {
    untracked(() => props.onClose)();
    if (to.kind === "note") return router.navigate(pkmHref(to.id));
    if (to.kind === "notes") return notesSearch.open(to.id);
    if (to.kind !== "profile") return router.navigate(chatPath(channelOf(untracked(core)?.chat, to.id)));
    const agent = to.id;
    void act.run(async () => router.navigate(`/chat/${await api.channel.direct.create({ agent })}`));
  };
  return (
    <Command
      testID="switcher-input"
      accessibilityLabel={t("web.channel.switcher.title")}
      placeholder={t("web.channel.switcher.hint")}
      autoFocus
      filterable={false}
      query={query()}
      onQueryChange={(e) => query.set(e.query)}
      onCancel={() => props.onClose()}
      items={targets().map((s) => ({ id: keyOf(s), label: s.label, keywords: [s.hint] }))}
      onSelect={(e) => {
        const to = targets().find((s) => keyOf(s) === e.id);
        if (to) go(to);
      }}
      class="gap-2"
      searchBarClass="h-10 flex-row items-center rounded-md border border-line bg-page px-3 focus-within:border-focus"
      searchClass="flex-1 text-base text-ink"
      listClass="max-h-96"
      itemClass="flex-row items-center gap-2 rounded-md px-2 py-1.5 focus:bg-selected"
      empty={<Text class="px-2 py-2 text-sm text-muted">{t("web.channel.switcher.none")}</Text>}
      renderItem={(entry) => {
        const target = targets().find((s) => keyOf(s) === entry.id);
        return (
          <View testID={`switch-${entry.id}`} class="min-w-0 flex-1 flex-row items-center gap-2">
            <Text class={`min-w-0 flex-1 truncate text-sm text-ink ${(target?.unread ?? 0) > 0 ? "font-semibold" : ""}`}>{entry.label}</Text>
            <Text class="shrink-0 truncate text-xs text-muted">{target?.hint ?? ""}</Text>
            <If when={(target?.unread ?? 0) > 0}>
              <Count n={target?.unread ?? 0} />
            </If>
          </View>
        );
      }}
    />
  );
}
