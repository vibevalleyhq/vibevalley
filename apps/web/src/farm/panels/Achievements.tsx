import * as stylex from "@stylexjs/stylex";
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
import { styleProps } from "#/ui/positioner.ts";

import { Tinted } from "./rows";

const styles = stylex.create({
  medalFrame: { position: "absolute", inset: 0 },
  doneStamp: { position: "absolute", right: "-0.375rem", bottom: "-0.25rem" },
  titlePickerButton: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-cream-300)",
    backgroundColor: {
      default: "var(--color-cream-50)",
      "@media (hover:hover)": {
        default: null,
        ":enabled:hover": "var(--color-cream-200)",
      },
    },
    paddingBlock: "0.375rem",
    paddingRight: "0.75rem",
    paddingLeft: "0.375rem",
    textAlign: "left",
    cursor: {
      default: null,
      ":enabled": "pointer",
    },
    opacity: {
      default: null,
      ":disabled": ".6",
    },
  },
  standingTinted: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "1.5rem",
    rowGap: "0.75rem",
  },
  starterTinted: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    backgroundColor: "color-mix(in srgb, var(--color-leaf-300) 40%, var(--color-cream-50))",
  },
  titlePickerMenu: {
    position: "absolute",
    top: "100%",
    right: "0",
    zIndex: "10",
    marginTop: "0.5rem",
    maxHeight: "20rem",
    width: "16rem",
    overflowY: "auto",
    backgroundColor: "var(--color-cream-50)",
    padding: "0.375rem",
    boxShadow: "var(--shadow-px)",
  },
  medalImg: {
    position: "absolute",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  medalImgLocked: {
    opacity: ".5",
    filter: "grayscale(100%)",
  },
  titleItemLabel: {
    flex: "1",
    fontSize: "13px",
  },
  titleItemWorn: {
    color: "var(--color-leaf-700)",
  },
  starterImg: {
    height: "2.25rem",
    width: "2.25rem",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  starterImgPending: {
    opacity: ".6",
  },
  starterTitle: {
    display: "block",
    fontSize: "13px",
  },
  starterTitleDone: {
    color: "var(--color-bark-800)",
  },
  inkBark900: {
    color: "var(--color-bark-900)",
  },
  cardTitle: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "13px",
  },
  cardTitleLocked: {
    color: "var(--color-bark-600)",
  },
  medalWrap: (size: number) => ({
    position: "relative",
    display: "inline-block",
    flexShrink: "0",
    width: size,
    height: size,
  }),
  barTrack: (height: number) => ({
    display: "block",
    height,
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-cream-300)",
    backgroundColor: "var(--color-cream-200)",
  }),
  barFill: {
    display: "block",
    height: "100%",
    backgroundColor: "var(--color-leaf-500)",
  },
  heading: {
    marginBottom: "0.375rem",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  page: {
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
  },
  clearingList: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  clearingChip: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    paddingInline: "0.75rem",
    paddingBlock: "0.25rem",
    fontSize: "12px",
  },
  clearingDone: {
    backgroundColor: "color-mix(in srgb, var(--color-leaf-300) 70%, var(--color-cream-50))",
    color: "var(--color-bark-900)",
  },
  clearingLocked: {
    backgroundColor: "var(--color-cream-200)",
    color: "var(--color-bark-600)",
  },
  wallGrid: {
    display: "grid",
    gap: "0.5rem",
    gridTemplateColumns: {
      default: null,
      "@media (width>=40rem)": "repeat(2,minmax(0,1fr))",
    },
  },
  standingLevel: {
    display: "flex",
    maxWidth: "280px",
    minWidth: "160px",
    flexDirection: "column",
  },
  standingLevelHead: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: "0.5rem",
  },
  levelNumber: {
    fontSize: "20px",
    color: "var(--color-leaf-700)",
  },
  subtleNote: {
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  standingBarWrap: {
    marginTop: "0.375rem",
  },
  standingCoins: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  coinsValue: {
    fontSize: "20px",
  },
  titlePickerWrap: {
    position: "relative",
    marginLeft: "auto",
  },
  titlePickerCaption: {
    display: "block",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  titlePickerCurrent: {
    display: "block",
    fontSize: "13px",
  },
  titlePickerHeading: {
    paddingInline: "0.5rem",
    paddingTop: "0.25rem",
    paddingBottom: "0.375rem",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  titleItem: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.5rem",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    textAlign: "left",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-100)",
      },
    },
  },
  titleClearButton: {
    width: "100%",
    cursor: "pointer",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
    textAlign: "left",
    fontSize: "13px",
    color: "var(--color-bark-600)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-100)",
      },
    },
  },
  starterDoneText: {
    fontSize: "13px",
    color: "var(--color-bark-800)",
  },
  starterGrid: {
    display: "grid",
    gap: "0.375rem",
    gridTemplateColumns: {
      default: null,
      "@media (width>=40rem)": "repeat(2,minmax(0,1fr))",
    },
  },
  starterCard: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    paddingInline: "0.625rem",
    paddingBlock: "0.5rem",
  },
  starterCardDone: {
    backgroundColor: "color-mix(in srgb, var(--color-leaf-300) 35%, var(--color-cream-50))",
  },
  starterCardPending: {
    backgroundColor: "var(--color-cream-100)",
  },
  starterIconBox: {
    position: "relative",
    height: "2.25rem",
    width: "2.25rem",
    flexShrink: "0",
  },
  cardBody: {
    minWidth: "0",
    flex: "1",
  },
  starterDetail: {
    display: "block",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  starterReward: {
    display: "flex",
    alignItems: "center",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  card: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.75rem",
    padding: "0.625rem",
  },
  cardGold: {
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-px-gold-frame)",
    backgroundColor: "color-mix(in srgb, var(--color-wheat) 20%, var(--color-cream-50))",
  },
  cardPlain: {
    backgroundColor: "var(--color-cream-100)",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
  },
  pips: {
    display: "flex",
  },
  pip: {
    marginLeft: "0.25rem",
    height: "0.5rem",
    width: "0.5rem",
  },
  pipBronze: {
    backgroundColor: "var(--color-medal-bronze)",
  },
  pipSilver: {
    backgroundColor: "var(--color-medal-silver)",
  },
  pipGold: {
    backgroundColor: "var(--color-wheat)",
  },
  pipLocked: {
    backgroundColor: "var(--color-cream-300)",
  },
  cardDetail: {
    marginTop: "0.125rem",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  cardProgress: {
    marginTop: "0.375rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  cardProgressBar: {
    flex: "1",
  },
  cardEarned: {
    marginTop: "0.25rem",
    fontSize: "12px",
    color: "var(--color-bark-400)",
  },
  secretsCard: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    backgroundColor: "var(--color-cream-100)",
    padding: "0.625rem",
  },
  secretsTitle: {
    fontSize: "13px",
    color: "var(--color-bark-600)",
  },
});

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

const pipLook: Record<number, stylex.StyleXStyles> = {
  1: styles.pipBronze,
  2: styles.pipSilver,
  3: styles.pipGold,
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
    <span {...styleProps(styles.medalWrap(props.size))}>
      <SpriteIcon name={frame()} size={props.size} styles={styles.medalFrame} />
      <img
        src={`/pixel/emblem-${props.a.id}.png`}
        onError={(ev) => (ev.currentTarget.src = "/pixel/emblem-wreath.png")}
        alt=""
        {...stylex.attrs(styles.medalImg, !earned() && styles.medalImgLocked)}
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
      {...styleProps(styles.barTrack(props.height ?? 8))}
    >
      <span {...stylex.attrs(styles.barFill)} style={{ width: `${props.max <= 0 ? 0 : Math.min(1, Math.max(0, props.value / props.max)) * 100}%` }} />
    </span>
  );
}

function Heading(props: { text: string; aside?: string | undefined }) {
  return (
    <p {...stylex.attrs(styles.heading)}>
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
    <div {...stylex.attrs(styles.page)}>
      <Standing catalog={catalog()} />
      <Starter list={of("starter")} st={st()} />
      <div>
        <Heading text={t("web.farm.achievements.clearing")} />
        <div {...stylex.attrs(styles.clearingList)}>
          <For each={beds.filter((b) => b.unlockLevel !== undefined)}>
            {(b) => {
              const unlock = b.unlockLevel ?? 0;
              const done = () => level() >= unlock;
              return (
                <span {...stylex.attrs(styles.clearingChip, done() ? styles.clearingDone : styles.clearingLocked)}>
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
            <div {...stylex.attrs(styles.wallGrid)}>
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
    <Tinted styles={styles.standingTinted}>
      <div {...stylex.attrs(styles.standingLevel)}>
        <div {...stylex.attrs(styles.standingLevelHead)}>
          <span {...stylex.attrs(styles.levelNumber)}>Lv.{Math.round(lv().level)}</span>
          <span {...stylex.attrs(styles.subtleNote)}>
            {t("web.farm.achievements.toLevel", { left: need() - Math.round(lv().xp), total: Math.round(commits()) })}
          </span>
        </div>
        <span {...stylex.attrs(styles.standingBarWrap)}>
          <Bar value={lv().xp} max={need()} label={t("web.farm.achievements.toNext")} />
        </span>
      </div>
      <div {...stylex.attrs(styles.standingCoins)}>
        <SpriteIcon name="coins-stack" size={40} />
        <div>
          <p {...stylex.attrs(styles.coinsValue)}>{thousands(Math.round(p().coins))}</p>
          <p {...stylex.attrs(styles.subtleNote)}>
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
    <div ref={box} {...stylex.attrs(styles.titlePickerWrap)}>
      <button
        type="button"
        disabled={earned().length === 0}
        aria-expanded={aria(open())}
        onClick={() => setOpen(!open())}
        {...stylex.attrs(styles.titlePickerButton)}
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
          <span {...stylex.attrs(styles.titlePickerCaption)}>{t("web.farm.achievements.title")}</span>
          <span {...stylex.attrs(styles.titlePickerCurrent)}>
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
        <div {...stylex.attrs(styles.titlePickerMenu)} role="menu" aria-label={t("web.farm.achievements.titles")}>
          <p {...stylex.attrs(styles.titlePickerHeading)}>{t("web.farm.achievements.titles")}</p>
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
                  {...stylex.attrs(styles.titleItem)}
                >
                  <Medal a={e.a} tier={e.tier} size={28} />
                  <span {...stylex.attrs(styles.titleItemLabel, on() && styles.titleItemWorn)}>{tierTitle(e.a, e.tier)}</span>
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
              {...stylex.attrs(styles.titleClearButton)}
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
        <Tinted styles={styles.starterTinted}>
          <SpriteIcon name="emblem-starter" size={28} />
          <span {...stylex.attrs(styles.starterDoneText)}>{t("web.farm.achievements.starterDone")}</span>
        </Tinted>
      }
    >
      <div>
        <Heading
          text={t("web.farm.achievements.starter", { done: done(), of: props.list.length })}
          aside={props.list[0] ? t("web.farm.achievements.perStarter", { coins: Math.round(props.list[0].tiers[0]?.coins ?? 0) }) : undefined}
        />
        <div {...stylex.attrs(styles.starterGrid)}>
          <For each={props.list}>
            {(a) => {
              const ok = () => props.st(a).tier > 0;
              return (
                <div {...stylex.attrs(styles.starterCard, ok() ? styles.starterCardDone : styles.starterCardPending)}>
                  <span {...stylex.attrs(styles.starterIconBox)}>
                    <img
                      src={`/pixel/emblem-${a.id}.png`}
                      onError={(ev) => (ev.currentTarget.src = "/pixel/emblem-wreath.png")}
                      alt=""
                      {...stylex.attrs(styles.starterImg, !ok() && styles.starterImgPending)}
                    />
                    <Show when={ok()}>
                      <SpriteIcon name="stamp-done" size={20} label={t("web.farm.achievements.done")} styles={styles.doneStamp} />
                    </Show>
                  </span>
                  <span {...stylex.attrs(styles.cardBody)}>
                    <span {...stylex.attrs(styles.starterTitle, ok() ? styles.starterTitleDone : styles.inkBark900)}>{a.title}</span>
                    <span {...stylex.attrs(styles.starterDetail)} title={a.detail}>
                      {a.detail}
                    </span>
                  </span>
                  <Show when={!ok()}>
                    <span {...stylex.attrs(styles.starterReward)}>
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
    <div {...stylex.attrs(styles.card, standing().tier === 3 ? styles.cardGold : styles.cardPlain)}>
      <Medal a={props.a} tier={standing().tier} size={60} />
      <div {...stylex.attrs(styles.cardBody)}>
        <div {...stylex.attrs(styles.cardHeader)}>
          <span {...stylex.attrs(styles.cardTitle, standing().tier > 0 ? styles.inkBark900 : styles.cardTitleLocked)}>
            {tierTitle(props.a, standing().tier < 1 ? 1 : standing().tier)}
          </span>
          <Show when={props.a.tiers.length > 1}>
            <span {...stylex.attrs(styles.pips)} aria-label={t("web.farm.achievements.tiers", { tier: standing().tier, of: props.a.tiers.length })}>
              <For each={props.a.tiers}>
                {(tier, i) => (
                  <span
                    title={t("shared.join.labeled", { label: tierText(i() + 1), text: `${numberText(tier.need)} ${unit()}` })}
                    {...styleProps([styles.pip, i() < standing().tier ? (pipLook[i() + 1] ?? styles.pipLocked) : styles.pipLocked])}
                  />
                )}
              </For>
            </span>
          </Show>
        </div>
        <p {...stylex.attrs(styles.cardDetail)}>{props.a.detail}</p>
        <Show when={standing().next}>
          {(next) => (
            <div {...stylex.attrs(styles.cardProgress)}>
              <span {...stylex.attrs(styles.cardProgressBar)}>
                <Bar
                  value={Math.min(standing().count, next())}
                  max={next()}
                  height={6}
                  label={t("web.farm.achievements.toTier", { tier: tierText(standing().tier + 1) })}
                />
              </span>
              <span {...stylex.attrs(styles.subtleNote)}>
                {standing().count}/{next()} {unit()}
              </span>
            </div>
          )}
        </Show>
        <Show when={at()}>
          {(when) => (
            <p {...stylex.attrs(styles.cardEarned)}>
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
      <div {...stylex.attrs(styles.wallGrid)}>
        <For each={found()}>{(a) => <Card a={a} p={props.p} st={props.st} />}</For>
        <Show when={left() > 0}>
          <div {...stylex.attrs(styles.secretsCard)}>
            <SpriteIcon name="medal-locked" size={60} />
            <div>
              <p {...stylex.attrs(styles.secretsTitle)}>{t("web.farm.achievements.secrets", { n: left() })}</p>
              <p {...stylex.attrs(styles.subtleNote)}>{t("web.farm.achievements.secretsLine")}</p>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
