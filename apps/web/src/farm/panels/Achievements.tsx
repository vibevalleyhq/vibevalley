import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Achievement, AchievementCategory, AchievementStanding, Progress } from "@vibevalley/protocol";

import { aria, useClickAway } from "#/base/dom.tsx";
import { commands } from "#/farm/frames.ts";
import { thousands } from "#/farm/hud/readout.ts";
import { beds } from "#/farm/world/plots.ts";
import { useCore, useFrames } from "#/infra/frame.ts";
import { achievementsQuery, ready, useQuery } from "#/infra/query.ts";
import { createPixelAct, numberText, SpriteIcon } from "#/ui/pixel/index.ts";

import { Tinted } from "./rows";

const styles = {
  medalWrap: (size: number): JSX.CSSProperties => ({ width: `${size}px`, height: `${size}px` }),
  barTrack: (height: number): JSX.CSSProperties => ({ height: `${height}px` }),
};

const walls: AchievementCategory[] = ["harvest", "craft", "thrift", "team"];

/** A tier's metal: bronze, silver, gold. */
const tierText = (tier: number) => (tier === 1 || tier === 2 || tier === 3 ? t(`web.farm.achievements.tier.${tier}`) : "");

const categoryText: Record<AchievementCategory, string> = {
  starter: t("web.farm.achievements.category.starter"),
  harvest: t("web.farm.achievements.category.harvest"),
  craft: t("web.farm.achievements.category.craft"),
  thrift: t("web.farm.achievements.category.thrift"),
  team: t("web.farm.achievements.category.team"),
  secret: t("web.farm.achievements.category.secret"),
};

const pipLook: Record<number, JSX.ClassValue> = {
  1: "bg-medal-bronze",
  2: "bg-medal-silver",
  3: "bg-wheat",
};

const emptyProgress: Progress = { coins: 0, streak: 0, bestStreak: 0, counts: {}, unlocked: [], agents: {} };

const day = (at: number) => {
  const d = new Date(Math.round(at));
  return t("web.farm.achievements.day", { month: d.getMonth() + 1, day: d.getDate() });
};

/** The tier's name; the achievement's own before the first. */
const tierTitle = (a: Achievement, tier: number) => (tier >= 1 && tier <= a.tiers.length ? (a.tiers[tier - 1]?.title ?? a.title) : a.title);

const reachedAt = (p: Progress, id: string, tier: number) => p.unlocked.find((u) => u.id === id && u.tier === tier)?.at;

type Standings = (a: Achievement) => { tier: number; count: number; next: number | undefined };

const standingsOf = (list: readonly AchievementStanding[]): Standings => {
  const by = new Map(list.map((s) => [s.id, s]));
  return (a) => {
    const s = by.get(a.id);
    return { tier: Math.round(s?.tier ?? 0), count: Math.round(s?.count ?? 0), next: s?.next === undefined ? undefined : Math.round(s.next) };
  };
};

/** An emblem in its frame: wood before the first tier, then bronze, silver, gold (one tier alone is gold). */
function Medal(props: { a: Achievement; tier: number; size: number }) {
  const earned = () => props.tier > 0;
  const frame = () => {
    const frameTier = props.a.tiers.length === 1 ? 3 : props.tier;
    return !earned() ? "medal-wood" : frameTier === 1 ? "medal-bronze" : frameTier === 2 ? "medal-silver" : "medal-gold";
  };
  // Where each frame's empty disc is, as a share of the square: high on the ribbon frames, all of the wooden one.
  const place = () => {
    const [top, share] = earned() ? [0.409, 0.44] : [0.5, 0.5];
    const e = props.size * share;
    return { left: (props.size - e) / 2, top: props.size * top - e / 2, e };
  };
  return (
    <span class="relative inline-block shrink-0" style={styles.medalWrap(props.size)}>
      <SpriteIcon name={frame()} size={props.size} class="absolute inset-0" />
      <img
        src={`/pixel/emblem-${props.a.id}.png`}
        onError={(ev) => (ev.currentTarget.src = "/pixel/emblem-wreath.png")}
        alt=""
        class={["absolute object-contain [image-rendering:pixelated]", !earned() && "opacity-50 [filter:grayscale(100%)]"]}
        style={{ left: `${place().left}px`, top: `${place().top}px`, width: `${place().e}px`, height: `${place().e}px` }}
      />
    </span>
  );
}

function Bar(props: { value: number; max: number; height?: number; label?: string }) {
  return (
    <span
      role="progressbar"
      aria-label={props.label}
      aria-valuenow={Math.round(props.value)}
      aria-valuemax={Math.round(props.max)}
      class="block border border-cream-300 bg-cream-200"
      style={styles.barTrack(props.height ?? 8)}
    >
      <span class="block h-full bg-leaf-500" style={{ width: `${props.max <= 0 ? 0 : Math.min(1, Math.max(0, props.value / props.max)) * 100}%` }} />
    </span>
  );
}

function Heading(props: { text: string; aside?: string | undefined }) {
  return (
    <p class="mb-1.5 text-(length:--text-xs) text-bark-600">
      {props.text}
      {props.aside && `  ${props.aside}`}
    </p>
  );
}

export function Achievements() {
  const core = useCore();
  const frames = useFrames();
  const catalogQuery = useQuery(achievementsQuery);
  const catalog = () => ready(catalogQuery, []);
  const p = () => core()?.progress ?? emptyProgress;
  const level = () => Math.round(frames.frame?.view.level.level ?? 1);
  const st = () => standingsOf(frames.frame?.view.achievements ?? []);
  const of = (c: AchievementCategory) => catalog().filter((a) => a.category === c);
  return (
    <div class="flex flex-col gap-5">
      <Standing catalog={catalog()} />
      <Starter list={of("starter")} st={st()} />
      <div>
        <Heading text={t("web.farm.achievements.clearing")} />
        <div class="flex flex-wrap gap-2">
          <For each={beds.filter((b) => b.unlockLevel !== undefined)}>
            {(b) => {
              const unlock = b.unlockLevel ?? 0;
              const done = () => level() >= unlock;
              return (
                <span
                  class={[
                    "flex items-center gap-1 px-3 py-1 text-(length:--text-xs)",
                    done() ? "bg-[color-mix(in_srgb,_var(--color-leaf-300)_70%,_var(--color-cream-50))] text-bark-900" : "bg-cream-200 text-bark-600",
                  ]}
                >
                  {t("web.farm.achievements.clearAt", { level: unlock })}
                  <Show when={done()}>
                    <SpriteIcon name="mark-check" size={12} />
                  </Show>
                </span>
              );
            }}
          </For>
        </div>
      </div>
      <For each={walls}>
        {(c) => (
          <div>
            <Heading text={`${categoryText[c]} ${of(c).filter((a) => st()(a).tier > 0).length}/${of(c).length}`} />
            <div class="grid gap-2 sm:grid-cols-2">
              <For each={of(c)}>{(a) => <Card a={a} p={p()} st={st()} />}</For>
            </div>
          </div>
        )}
      </For>
      <Secrets list={of("secret")} p={p()} st={st()} />
    </div>
  );
}

function Standing(props: { catalog: readonly Achievement[] }) {
  const core = useCore();
  const frames = useFrames();
  const p = () => core()?.progress ?? emptyProgress;
  const lv = () => frames.frame?.view.level ?? { level: 1, xp: 0, need: 10 };
  const commits = () => core()?.commits?.total ?? 0;
  const need = () => Math.round(lv().need);
  return (
    <Tinted class="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div class="flex max-w-70 min-w-40 flex-col">
        <div class="flex flex-wrap items-end gap-2">
          <span class="text-(length:--text-xl) text-leaf-700">Lv.{Math.round(lv().level)}</span>
          <span class="text-(length:--text-xs) text-bark-600">
            {t("web.farm.achievements.toLevel", { left: need() - Math.round(lv().xp), total: Math.round(commits()) })}
          </span>
        </div>
        <span class="mt-1.5">
          <Bar value={lv().xp} max={need()} label={t("web.farm.achievements.toNext")} />
        </span>
      </div>
      <div class="flex items-center gap-2">
        <SpriteIcon name="coins-stack" size={40} />
        <div>
          <p class="text-(length:--text-xl)">{thousands(Math.round(p().coins))}</p>
          <p class="text-(length:--text-xs) text-bark-600">
            {p().streak > 1
              ? t("web.farm.achievements.streak", { n: Math.round(p().streak), multiplier: (p().multiplier ?? 1).toFixed(1) })
              : t("web.farm.achievements.coinsOnMerge")}
          </p>
        </div>
      </div>
      <TitlePicker p={p()} catalog={props.catalog} />
    </Tinted>
  );
}

/** Any tier reached can be worn, not a starter task's. */
function TitlePicker(props: { p: Progress; catalog: readonly Achievement[] }) {
  const [open, setOpen] = createSignal(false);
  const act = createPixelAct();
  const box = useClickAway(open, () => setOpen(false));
  const title = () => props.p.title;
  const worn = () => {
    const t = title();
    return t ? props.catalog.find((a) => a.id === t.id) : undefined;
  };
  const earned = () =>
    props.catalog
      .filter((a) => a.wearable)
      .flatMap((a) => a.tiers.flatMap((_, i) => (props.p.unlocked.some((u) => u.id === a.id && u.tier === i + 1) ? [{ a, tier: i + 1 }] : [])));
  return (
    <div ref={box} class="relative ml-auto">
      <button
        type="button"
        disabled={earned().length === 0}
        aria-expanded={aria(open())}
        onClick={() => setOpen(!open())}
        class="flex items-center gap-2 border-2 border-cream-300 bg-cream-50 enabled:hover:bg-cream-200 py-1.5 pr-3 pl-1.5 text-left enabled:cursor-pointer disabled:opacity-60"
      >
        <Show
          when={(() => {
            const a = worn();
            const cur = title();
            return a && cur ? { a, tier: Math.round(cur.tier) } : undefined;
          })()}
          fallback={<SpriteIcon name="banner-title" size={48} />}
        >
          {(w) => <Medal a={w().a} tier={w().tier} size={32} />}
        </Show>
        <span>
          <span class="block text-(length:--text-xs) text-bark-600">{t("web.farm.achievements.title")}</span>
          <span class="block text-(length:--text-sm)">
            {(() => {
              const a = worn();
              const cur = title();
              return a && cur
                ? tierTitle(a, Math.round(cur.tier))
                : earned().length > 0
                  ? t("web.farm.achievements.pick")
                  : t("web.farm.achievements.earnFirst");
            })()}
          </span>
        </span>
      </button>
      <Show when={open()}>
        <div
          class="absolute top-full right-0 z-10 mt-2 max-h-80 w-64 overflow-y-auto bg-cream-50 p-1.5 shadow-px"
          role="menu"
          aria-label={t("web.farm.achievements.titles")}
        >
          <p class="px-2 pt-1 pb-1.5 text-(length:--text-xs) text-bark-600">{t("web.farm.achievements.titles")}</p>
          <For each={earned()}>
            {(e) => {
              const on = () => title()?.id === e.a.id && title()?.tier === e.tier;
              return (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void act.run(() => commands.chooseTitle(e.a.id, e.tier));
                    setOpen(false);
                  }}
                  class="flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left hover:bg-cream-100"
                >
                  <Medal a={e.a} tier={e.tier} size={28} />
                  <span class={["flex-1 text-(length:--text-sm)", on() && "text-leaf-700"]}>{tierTitle(e.a, e.tier)}</span>
                  <Show when={on()}>
                    <SpriteIcon name="mark-check" size={14} label={t("web.farm.achievements.worn")} />
                  </Show>
                </button>
              );
            }}
          </For>
          <Show when={title()}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void act.run(() => commands.chooseTitle());
                setOpen(false);
              }}
              class="w-full cursor-pointer px-2 py-1.5 text-left text-(length:--text-sm) text-bark-600 hover:bg-cream-100"
            >
              {t("web.farm.achievements.none")}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function Starter(props: { list: readonly Achievement[]; st: Standings }) {
  const done = () => props.list.filter((a) => props.st(a).tier > 0).length;
  return (
    <Show
      when={!(props.list.length > 0 && done() === props.list.length)}
      fallback={
        <Tinted class="flex items-center gap-2 bg-[color-mix(in_srgb,_var(--color-leaf-300)_40%,_var(--color-cream-50))]">
          <SpriteIcon name="emblem-starter" size={28} />
          <span class="text-(length:--text-sm) text-bark-800">{t("web.farm.achievements.starterDone")}</span>
        </Tinted>
      }
    >
      <div>
        <Heading
          text={t("web.farm.achievements.starter", { done: done(), of: props.list.length })}
          aside={props.list[0] ? t("web.farm.achievements.perStarter", { coins: Math.round(props.list[0].tiers[0]?.coins ?? 0) }) : undefined}
        />
        <div class="grid gap-1.5 sm:grid-cols-2">
          <For each={props.list}>
            {(a) => {
              const ok = () => props.st(a).tier > 0;
              return (
                <div
                  class={[
                    "flex items-center gap-2.5 px-2.5 py-2",
                    ok() ? "bg-[color-mix(in_srgb,_var(--color-leaf-300)_35%,_var(--color-cream-50))]" : "bg-cream-100",
                  ]}
                >
                  <span class="relative h-9 w-9 shrink-0">
                    <img
                      src={`/pixel/emblem-${a.id}.png`}
                      onError={(ev) => (ev.currentTarget.src = "/pixel/emblem-wreath.png")}
                      alt=""
                      class={["h-9 w-9 object-contain [image-rendering:pixelated]", !ok() && "opacity-60"]}
                    />
                    <Show when={ok()}>
                      <SpriteIcon name="stamp-done" size={20} label={t("web.farm.achievements.done")} class="absolute -right-1.5 -bottom-1" />
                    </Show>
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class={["block text-(length:--text-sm)", ok() ? "text-bark-800" : "text-bark-900"]}>{a.title}</span>
                    <span class="block truncate text-(length:--text-xs) text-bark-600" title={a.detail}>
                      {a.detail}
                    </span>
                  </span>
                  <Show when={!ok()}>
                    <span class="flex items-center text-(length:--text-xs) text-bark-600">
                      <SpriteIcon name="icon-coin" size={16} />+{Math.round(a.tiers[0]?.coins ?? 0)}
                    </span>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
}

function Card(props: { a: Achievement; p: Progress; st: Standings }) {
  const standing = () => props.st(props.a);
  const at = () => (standing().tier > 0 ? reachedAt(props.p, props.a.id, standing().tier) : undefined);
  const unit = () => props.a.unit ?? "";
  return (
    <div
      class={[
        "flex items-start gap-3 p-2.5",
        standing().tier === 3 ? "border-2 border-px-gold-frame bg-[color-mix(in_srgb,_var(--color-wheat)_20%,_var(--color-cream-50))]" : "bg-cream-100",
      ]}
    >
      <Medal a={props.a} tier={standing().tier} size={60} />
      <div class="min-w-0 flex-1">
        <div class="flex items-center">
          <span class={["min-w-0 flex-1 truncate text-(length:--text-sm)", standing().tier > 0 ? "text-bark-900" : "text-bark-600"]}>
            {tierTitle(props.a, standing().tier < 1 ? 1 : standing().tier)}
          </span>
          <Show when={props.a.tiers.length > 1}>
            <span class="flex" aria-label={t("web.farm.achievements.tiers", { tier: standing().tier, of: props.a.tiers.length })}>
              <For each={props.a.tiers}>
                {(tier, i) => (
                  <span
                    title={t("shared.join.labeled", { label: tierText(i() + 1), text: `${numberText(tier.need)} ${unit()}` })}
                    class={["ml-1 h-2 w-2", i() < standing().tier ? (pipLook[i() + 1] ?? "bg-cream-300") : "bg-cream-300"]}
                  />
                )}
              </For>
            </span>
          </Show>
        </div>
        <p class="mt-0.5 text-(length:--text-xs) text-bark-600">{props.a.detail}</p>
        <Show when={standing().next}>
          {(next) => (
            <div class="mt-1.5 flex items-center gap-2">
              <span class="flex-1">
                <Bar
                  value={Math.min(standing().count, next())}
                  max={next()}
                  height={6}
                  label={t("web.farm.achievements.toTier", { tier: tierText(standing().tier + 1) })}
                />
              </span>
              <span class="text-(length:--text-xs) text-bark-600">
                {standing().count}/{next()} {unit()}
              </span>
            </div>
          )}
        </Show>
        <Show when={at()}>
          {(when) => (
            <p class="mt-1 text-(length:--text-xs) text-bark-400">
              {props.a.tiers.length > 1 && tierText(standing().tier)
                ? t("web.farm.achievements.earnedTier", { day: day(when()), tier: tierText(standing().tier) })
                : t("web.farm.achievements.earned", { day: day(when()) })}
            </p>
          )}
        </Show>
      </div>
    </div>
  );
}

function Secrets(props: { list: readonly Achievement[]; p: Progress; st: Standings }) {
  const found = () => props.list.filter((a) => props.st(a).tier > 0);
  const left = () => props.list.length - found().length;
  return (
    <div>
      <Heading text={`${categoryText.secret} ${found().length}/${props.list.length}`} />
      <div class="grid gap-2 sm:grid-cols-2">
        <For each={found()}>{(a) => <Card a={a} p={props.p} st={props.st} />}</For>
        <Show when={left() > 0}>
          <div class="flex items-center gap-3 bg-cream-100 p-2.5">
            <SpriteIcon name="medal-locked" size={60} />
            <div>
              <p class="text-(length:--text-sm) text-bark-600">{t("web.farm.achievements.secrets", { n: left() })}</p>
              <p class="text-(length:--text-xs) text-bark-600">{t("web.farm.achievements.secretsLine")}</p>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
