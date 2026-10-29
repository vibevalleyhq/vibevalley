import { t } from "@vibevalley/i18n";
// How much the runtimes' accounts have left: a bottle at the HUD's top right, filled to the lowest of them; open, each
// runtime's machine, usage windows, today's spend and a stop it is under.

import { yuan } from "@/base/format";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { AccountUsage, RuntimeInfo } from "@vibevalley/protocol";
import { bottleSprite, quotaLevel, quotaOf, resetText, usableRuntimes, windowLabel } from "@/features/runtime";
import { aria, useClickAway } from "@/base/util";
import { ready, useRuntimes } from "@/base/query";
import { CardColors, PxButton, SpriteIcon } from "@/ui/pixel";
import { commands } from "@/farm/state";
import { HudCard } from "./HudCard";
import { RuntimeIcon } from "@/ui/pixel/RuntimeIcon";

const levelInk = { plenty: "#3f6427", low: "#b8862a", gold: "#b8862a", empty: "#c84a3a", unknown: "#7f5b3b" } as const;

function UsageLines(props: { usage: AccountUsage | null }) {
  return (
    <Switch fallback={<p class="text-[12px] text-bark-400">{t("web.farm.quota.unreported")}</p>}>
      <Match when={props.usage?.status === "login_required"}>
        <p class="text-[12px] text-wheat-700">{t("web.farm.quota.signedOut")}</p>
      </Match>
      <Match when={props.usage?.status === "unavailable" ? props.usage : undefined}>
        {(u) => <p class="text-[12px] text-bark-400">{t("web.farm.quota.unreadable", { why: u().reason })}</p>}
      </Match>
      <Match when={props.usage?.status === "balance" ? props.usage : undefined}>
        {(u) => (
          <p class="text-[12px]" style={{ color: u().available ? "#2f1f13" : "#c84a3a" }}>
            {t("web.farm.quota.balance", { provider: u().provider, enough: u().available })}
          </p>
        )}
      </Match>
      <Match when={props.usage?.status === "ok" ? props.usage : undefined}>
        {(u) => (
          <div class="mt-1 flex flex-col gap-1">
            <For each={u().windows}>
              {(w) => {
                const left = () => 100 - w.usedPercent;
                return (
                  <div class="text-[12px]">
                    <div class="flex justify-between gap-2">
                      <span class="truncate">{windowLabel(w.label)}</span>
                      <span style={{ color: levelInk[quotaLevel(left())] }}>{Math.round(left())}%</span>
                    </div>
                    <span class="block h-1.5 w-full" style={{ background: CardColors.barTrack }}>
                      <span class="block h-full" style={{ width: `${Math.max(0, Math.min(100, left()))}%`, background: levelInk[quotaLevel(left())] }} />
                    </span>
                    <Show when={w.resetsAt !== null}>
                      <span class="text-[10px] text-bark-400">{resetText(w.resetsAt!)}</span>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        )}
      </Match>
    </Switch>
  );
}

function Machine(props: { info: RuntimeInfo }) {
  const quota = () => quotaOf(props.info);
  const usage = () => props.info.usage;
  const subscription = () => {
    const u = usage();
    return u?.status === "ok" ? u.subscription : undefined;
  };
  return (
    <div class="flex gap-2.5 border-[1.5px] border-cream-200 bg-cream-100 p-2" data-testid="quota-machine">
      <RuntimeIcon runtime={props.info.id} size={34} />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <span class="text-[13px]">{props.info.preset.label}</span>
          <Show when={subscription()}>{(sub) => <span class="truncate text-[12px] text-bark-500">{sub()}</span>}</Show>
        </div>
        <UsageLines usage={usage()} />
        <Show when={props.info.spentToday !== undefined}>
          <p class="mt-0.5 text-[12px] text-bark-500">
            {(props.info.settings.dailyBudget ?? 0) > 0
              ? t("web.farm.quota.spentTodayBudget", { spent: yuan(props.info.spentToday!), budget: yuan(props.info.settings.dailyBudget!) })
              : t("web.farm.quota.spentToday", { spent: yuan(props.info.spentToday!) })}
          </p>
        </Show>
        <Show when={props.info.stop}>
          <p class="mt-0.5 text-[12px] text-berry">{props.info.stop}</p>
        </Show>
      </div>
      <div class="flex w-12 flex-col items-center">
        <SpriteIcon name={bottleSprite(quota())} size={40} label={quota().text} />
        <span class="text-[12px]" style={{ color: quota().level === "unknown" ? "#9b7550" : quota().level === "empty" ? "#c84a3a" : "#46301d" }}>
          {quota().short || "—"}
        </span>
      </div>
    </div>
  );
}

export function QuotaPill(props: { height: number }) {
  const all = useRuntimes();
  const runtimes = () => usableRuntimes(ready(all, []));
  const [open, setOpen] = createSignal(false);
  const box = useClickAway(open, () => setOpen(false));
  const lowest = () => {
    const lefts = runtimes().flatMap((r) => (r.quota?.left === undefined ? [] : [r.quota.left]));
    return lefts.length ? Math.min(...lefts) : undefined;
  };
  const shown = () => {
    const l = lowest();
    return l === undefined ? undefined : Math.round(l);
  };
  return (
    <Show when={runtimes().length > 0}>
      <div ref={box} class="pointer-events-auto relative">
        <button
          type="button"
          aria-label={shown() === undefined ? t("web.farm.quota.all") : t("web.farm.quota.lowest", { pct: String(shown()) })}
          aria-expanded={aria(open())}
          onClick={() => setOpen(!open())}
          class="cursor-pointer"
        >
          <HudCard height={props.height} bright={open()}>
            <SpriteIcon
              name={bottleSprite({ level: quotaLevel(lowest()), fill: lowest() === undefined ? 0 : lowest()! / 100, short: "", text: "" })}
              size={28}
            />
            <span style={{ color: lowest() === undefined ? "#2f1f13" : levelInk[quotaLevel(lowest())] }}>
              {shown() === undefined ? t("web.farm.quota.quota") : `${shown()}%`}
            </span>
          </HudCard>
        </button>
        <Show when={open()}>
          <div class="absolute top-full right-0 z-10 mt-2 w-[352px] bg-cream-50 p-3 shadow-px" role="dialog" aria-label={t("web.farm.quota.left")}>
            <div class="flex items-center">
              <span class="flex-1 text-[13px]">{t("web.farm.quota.left")}</span>
              <PxButton
                size="icon"
                label={t("web.farm.quota.refresh")}
                onClick={() => runtimes().forEach((r) => void commands.refreshRuntime(r.id).catch(() => {}))}
              >
                <SpriteIcon name="button-refresh" size={14} />
              </PxButton>
            </div>
            <div class="mt-2 flex max-h-[min(512px,70vh)] flex-col gap-3 overflow-y-auto">
              <For each={runtimes()} keyed={(r) => r.id}>
                {(r) => <Machine info={r()} />}
              </For>
            </div>
            <p class="mt-2 text-[12px] text-bark-400">{t("web.farm.quota.note")}</p>
          </div>
        </Show>
      </div>
    </Show>
  );
}
