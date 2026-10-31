import { createMemo, createSignal, For, Show, untrack } from "solid-js";

import { Combobox } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";

import { autofocus } from "@/base/util";
import { useWorkAgents } from "@/infra/agents";
import { api } from "@/infra/api";
import { useCore } from "@/infra/frame";
import { useRouter } from "@/infra/router";
import { createAct } from "@/ui/act";
import { Dialog } from "@/ui/Dialog";

import { Count } from "./bits";
import { channelOf, chatPath } from "./places";
import { type SwitchTarget, switchTargets } from "./switcher";

const [shown, setShown] = createSignal(false);

/** One switcher for the page: the shell's Ctrl+K and the chat sidebar's bar open the same one. */
export const switcher = { show: () => setShown(true), toggle: () => setShown((s) => !s) };

/** Ctrl+K: a channel, thread or direct channel by its name; a profile not yet talked with gets its direct channel. */
export function QuickSwitcher() {
  return (
    <Dialog open={shown()} onClose={() => setShown(false)} title={t("web.channel.switcher.title")} testid="switcher">
      <SwitcherBody onClose={() => setShown(false)} />
    </Dialog>
  );
}

function SwitcherBody(props: { onClose: () => void }) {
  const core = useCore();
  const router = useRouter();
  const profiles = useWorkAgents();
  const [query, setQuery] = createSignal("");
  const targets = createMemo(() =>
    switchTargets(core()?.chat, query(), { issues: core()?.issues ?? [], sessions: core()?.sessions ?? [], profiles: profiles() }),
  );
  // Made here, not in go: the dialog closes as the owner picks, and the act outlives it.
  const act = createAct();
  const go = (t: SwitchTarget) => {
    untrack(() => props.onClose)();
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
          class="h-10 rounded-md border border-line bg-page px-3 text-base outline-none focus:border-focus"
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
                <span class={["min-w-0 flex-1 truncate text-sm", { "font-semibold": t().unread > 0 }]}>{t().label}</span>
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
