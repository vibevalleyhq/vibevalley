import { signal, Text, untracked, View } from "nsh";
import { Command } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { channelOf } from "@vibevalley/protocol/rules";

import { createAct } from "../../../design/act";
import { Dialog } from "../../../design/Dialog";
import { OrchestratorFace } from "../../../design/domain/Face";
import { Icon } from "../../../design/Icon";
import { Kbd } from "../../../design/layout";
import { motionClass } from "../../../design/motion";
import { Bubble } from "../../../design/Tip";
import { useOrchestrators, useWorkAgents } from "../../../infra/agents";
import { api } from "../../../infra/api";
import { useBoardSlice, useCollabSlice, useSessionsSlice } from "../../../infra/frame";
import { useRouter } from "../../../infra/router";
import { createMemo } from "../../../infra/solid";
import { defineAtom } from "../../../infra/state/atom";
import { chatPath, directPeerOf, type SwitchTarget, switchTargets } from "../model/places";
import { Count, HelperFace } from "./presence";

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

function displayLabel(target: SwitchTarget): string {
  if (target.kind === "channel") return target.label.replace(/^#/u, "");
  if (target.kind === "direct" || target.kind === "profile") return target.label.replace(/^@/u, "");
  return target.label;
}

function SwitcherBody(props: { onClose: () => void }) {
  const collab = useCollabSlice();
  const board = useBoardSlice();
  const sessions = useSessionsSlice();
  const router = useRouter();
  const profiles = useWorkAgents();
  const orchestrators = useOrchestrators();
  const query = signal("");
  const grouped = createMemo(() => {
    const chat = switchTargets(collab()?.chat, query(), {
      issues: board()?.issues ?? [],
      sessions: sessions()?.sessions ?? [],
      profiles: profiles(),
      channelSummary: collab()?.channelSummary,
    });
    const channels = chat.filter((s) => s.kind === "channel");
    const threads = chat.filter((s) => s.kind === "thread");
    const directs = chat.filter((s) => s.kind === "direct" || s.kind === "profile");
    return [
      ...channels.map((target) => ({ target, group: t("web.channel.channelsTitle") })),
      ...threads.map((target) => ({ target, group: t("web.channel.thread") })),
      ...directs.map((target) => ({ target, group: t("web.channel.directsTitle") })),
    ];
  });
  const byId = createMemo(() => new Map(grouped().map((item) => [keyOf(item.target), item.target])));
  const isOrchestrator = (id: string) => orchestrators().some((a) => a.id === id);
  // Made here, not in go: the dialog closes as the user picks, and the act outlives it.
  const act = createAct();
  const go = (to: SwitchTarget) => {
    untracked(() => props.onClose)();
    if (to.kind !== "profile") return router.navigate(chatPath(channelOf(untracked(collab)?.chat, to.id)));
    const agent = to.id;
    void act.run(async () => router.navigate(`/chat/${await api.channel.direct.create({ agent })}`));
  };
  const directPeer = (target: SwitchTarget): string | undefined => {
    if (target.kind === "profile") return target.id;
    if (target.kind !== "direct") return undefined;
    return directPeerOf(channelOf(collab()?.chat, target.id));
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
      items={grouped().map(({ target, group }) => ({ id: keyOf(target), label: target.label, keywords: [target.hint], group }))}
      onSelect={(e) => {
        const to = byId().get(e.id);
        if (to) go(to);
      }}
      class="gap-2.5"
      searchBarClass="h-10 flex-row items-center gap-2 rounded-md border border-line bg-page px-3 hover:border-faint focus-within:border-focus"
      searchPrefix={<Icon name="search" size={16} tone="muted" />}
      searchSuffix={
        <If when={query().length > 0}>
          <View
            role="button"
            accessibilityLabel={t("web.issue.page.clear")}
            tooltip={<Bubble text={t("web.issue.page.clear")} />}
            onPress={() => query.set("")}
            class={`size-5 shrink-0 items-center justify-center rounded-sm ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px`}
          >
            <Icon name="close" size={12} tone="muted" />
          </View>
        </If>
      }
      searchClass="min-w-0 flex-1 text-base text-ink placeholder:text-faint"
      listClass="max-h-96"
      separatorClass="my-1.5 h-px bg-line"
      renderGroup={(g) => (
        <View class="px-2.5 pt-1.5 pb-1">
          <Text class="text-xs font-semibold text-muted">{g.heading}</Text>
        </View>
      )}
      itemClass="group h-8.5 flex-row items-center rounded-md px-2.5 hover:bg-hover focus:bg-selected"
      empty={
        <View class="items-center py-8">
          <Text class="text-sm text-muted">{t("web.channel.switcher.none")}</Text>
        </View>
      }
      footer={
        <View class="flex-row items-center gap-3 border-t border-line pt-2.5">
          <View class="flex-row items-center gap-1.5">
            <Kbd>↑↓</Kbd>
            <Text class="text-2xs text-faint">{t("web.base.shortcuts.say.move")}</Text>
          </View>
          <View class="flex-row items-center gap-1.5">
            <Kbd>⏎</Kbd>
            <Text class="text-2xs text-faint">{t("web.base.shortcuts.say.pick")}</Text>
          </View>
          <View class="flex-row items-center gap-1.5">
            <Kbd>Esc</Kbd>
            <Text class="text-2xs text-faint">{t("web.base.lightbox.close")}</Text>
          </View>
        </View>
      }
      renderItem={(entry) => {
        const target = () => byId().get(entry.id);
        const peer = () => {
          const item = target();
          return item ? directPeer(item) : undefined;
        };
        const label = () => {
          const item = target();
          return item ? displayLabel(item) : entry.label;
        };
        return (
          <View testID={`switch-${entry.id}`} class="min-w-0 flex-1 flex-row items-center gap-2.5">
            <View class="size-5 shrink-0 items-center justify-center">
              <If when={target()?.kind === "channel"}>
                <Icon name="chat" size={14} tone="muted" />
              </If>
              <If when={target()?.kind === "thread"}>
                <Icon name="thread" size={14} tone="muted" />
              </If>
              <If when={target()?.kind === "direct" || target()?.kind === "profile"}>
                <If when={peer()} else={<Icon name="mention" size={14} tone="muted" />}>
                  {(id) => (
                    <If when={isOrchestrator(id())} else={<HelperFace agent={id()} size={20} />}>
                      <OrchestratorFace size={20} agent={id()} />
                    </If>
                  )}
                </If>
              </If>
            </View>
            <Text class={`min-w-0 flex-1 truncate text-sm text-ink ${(target()?.unread ?? 0) > 0 ? "font-semibold" : "font-normal"}`}>{label()}</Text>
            <If when={target()?.hint}>{(hint) => <Text class="max-w-36 shrink-0 truncate text-right text-xs text-muted">{hint()}</Text>}</If>
            <If when={(target()?.unread ?? 0) > 0}>
              <Count n={target()?.unread ?? 0} />
            </If>
          </View>
        );
      }}
    />
  );
}
