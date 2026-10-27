import { chatWording } from "./words";
import { createMemo, createSignal, For, Show, untrack } from "solid-js";
import { api, reasonOf } from "../../base/api";
import { useCore } from "../../base/frame";
import { useRouter } from "../../base/router";
import { useWorkAgents } from "../../base/agents";
import { aria, autofocus } from "../../base/util";
import { Dialog } from "../../ui/Dialog";
import { toast } from "../../ui/toasts";
import { Count } from "./bits";
import { channelOf, chatPath, type SwitchTarget, switchTargets } from "./rules";

const [shown, setShown] = createSignal(false);

/** One switcher for the page: the shell's Ctrl+K and the chat sidebar's bar open the same one. */
export const switcher = { show: () => setShown(true), toggle: () => setShown((s) => !s) };

/** Ctrl+K: a channel, thread or direct channel by its name; a profile not yet talked with gets its direct channel. */
export function QuickSwitcher() {
  return (
    <Dialog open={shown()} onClose={() => setShown(false)} title={chatWording().switcher.title}>
      <SwitcherBody onClose={() => setShown(false)} />
    </Dialog>
  );
}

function SwitcherBody(props: { onClose: () => void }) {
  const core = useCore();
  const router = useRouter();
  const profiles = useWorkAgents();
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const targets = createMemo(() =>
    switchTargets(core()?.chat, query(), { issues: core()?.issues ?? [], sessions: core()?.sessions ?? [], profiles: profiles() }),
  );
  const go = (t: SwitchTarget) => {
    untrack(() => props.onClose)();
    if (t.kind !== "profile") return router.navigate(chatPath(channelOf(untrack(core)?.chat, t.id)));
    api.channel.direct
      .create({ agent: t.id })
      .then((id) => router.navigate(`/chat/${id}`))
      .catch((e) => toast(reasonOf(e), "bad"));
  };
  return (
    <div class="flex flex-col gap-2">
      <input
        ref={autofocus()}
        value={query()}
        role="combobox"
        aria-expanded="true"
        aria-controls="switcher-list"
        aria-label={chatWording().switcher.title}
        placeholder={chatWording().switcher.hint}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.isComposing) return;
          const n = targets().length;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (n > 0) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
          } else if (e.key === "Enter") {
            e.preventDefault();
            const t = targets()[Math.min(active(), n - 1)];
            if (t) go(t);
          }
        }}
        class="h-10 rounded-md border border-line bg-page px-3 text-base outline-none focus:border-focus"
      />
      <div id="switcher-list" role="listbox" aria-label={chatWording().switcher.title} class="flex flex-col gap-0.5">
        <Show when={targets().length === 0}>
          <p class="px-2 py-2 text-sm text-muted">{chatWording().switcher.none}</p>
        </Show>
        <For each={targets()} keyed={(t) => `${t.kind}:${t.id}`}>
          {(t, i) => (
            <div
              role="option"
              aria-selected={aria(i() === active())}
              onMouseEnter={() => setActive(i())}
              onClick={() => go(t())}
              class={["flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5", { "bg-selected": i() === active() }]}
            >
              <span class={["min-w-0 flex-1 truncate text-sm", { "font-semibold": t().unread > 0 }]}>{t().label}</span>
              <span class="shrink-0 truncate text-xs text-muted">{t().hint}</span>
              <Show when={t().unread > 0}>
                <Count n={t().unread} />
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
