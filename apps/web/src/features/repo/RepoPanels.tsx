import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";

import { list, t } from "@vibevalley/i18n";
import type { RepoActivity, RepoLanguages, RepoSummary } from "@vibevalley/protocol";
import { githubRepository } from "@vibevalley/protocol/rules";

import { autofocus } from "#/base/dom.tsx";
import { useWorkAgents } from "#/infra/agents.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { type QueryResult, useQueryClient, ready } from "#/infra/query.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { AgentFace } from "#/ui/domain/Face.tsx";
import { Field, TextInput } from "#/ui/Field.tsx";
import { Card, Quiet } from "#/ui/layout.tsx";
import { SpriteIcon } from "#/ui/pixel/index.ts";
import { styleProps } from "#/ui/positioner.ts";
import { Segmented } from "#/ui/Segmented.tsx";

import { calendarOf, type CalendarDay, dayText, streaksOf } from "./calendar";
import { langIcon, languageShares, number, percent } from "./repos";

const tile = 12;
const tileGap = 3;

const styles = stylex.create({
  statSpan: {
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-medium)",
  },
  languagesDiv: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "0.25rem",
  },
  calendarRows: { gap: tileGap },
  calendarDay: { height: tile },
  calendarWeek: { gap: tileGap, marginLeft: tileGap },
  calendarFuture: { opacity: 0 },
  calendarReady: { opacity: 1 },
  calendarLoading: { opacity: 0.5 },
  statDiv: {
    display: "flex",
    minWidth: "4.5rem",
    flexDirection: "column",
  },
  statSpan2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  barSpan: {
    display: "block",
    height: "0.375rem",
    overflow: "hidden",
    borderRadius: "9999px",
    backgroundColor: "var(--color-hover)",
  },
  barSpan2: {
    display: "block",
    height: "100%",
    borderRadius: "9999px",
  },
  languagesDiv2: {
    display: "flex",
    height: "3.5rem",
    overflow: "hidden",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-bark)",
    padding: "0.25rem",
  },
  languagesSpan: {
    display: "flex",
    minWidth: "0.25rem",
    alignItems: "center",
    justifyContent: "center",
  },
  languagesDiv22: {
    display: "grid",
    columnGap: "1.5rem",
    rowGap: "0.5rem",
    gridTemplateColumns: {
      default: null,
      "@media (width>=40rem)": "repeat(2,minmax(0,1fr))",
    },
  },
  languagesDiv3: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
  },
  languagesSpan2: {
    display: "flex",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  languagesSpan3: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontWeight: "var(--font-weight-medium)",
  },
  languagesSpan4: {
    color: "var(--color-muted)",
  },
  languagesDiv4: {
    height: "3rem",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-hover)",
  },
  codeCode: {
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-selected)",
    paddingInline: "0.375rem",
    paddingBlock: "1px",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  notCountedDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-hover)",
    padding: "0.75rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  commitCalendarP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  commitCalendarDiv: {
    display: "grid",
    gridTemplateColumns: "repeat(4,minmax(0,1fr))",
    gap: "1.5rem",
  },
  commitCalendarDiv2: {
    overflowX: "auto",
    paddingBottom: "0.25rem",
  },
  commitCalendarDiv3: {
    minWidth: "704px",
  },
  commitCalendarDiv4: {
    position: "relative",
    height: "1rem",
  },
  commitCalendarSpan: {
    position: "absolute",
    top: "0",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  commitCalendarDiv5: {
    marginTop: "0.25rem",
    display: "flex",
  },
  commitCalendarDiv6: {
    display: "flex",
    width: "1.25rem",
    flexDirection: "column",
  },
  commitCalendarSpan2: {
    display: "flex",
    alignItems: "center",
    fontSize: "var(--text-2xs)",
    lineHeight: "1",
    color: "var(--color-muted)",
  },
  commitCalendarDiv7: {
    display: "flex",
    flexDirection: "column",
  },
  commitCalendarDiv8: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
  },
  commitCalendarSpan3: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  handsDiv: {
    display: "grid",
    gap: "0.625rem",
    gridTemplateColumns: {
      default: null,
      "@media (width>=40rem)": "repeat(2,minmax(0,1fr))",
    },
  },
  handsSpan: {
    display: "flex",
    width: "2rem",
    height: "2rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "9999px",
    backgroundColor: "var(--color-selected)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-medium)",
  },
  newRepoFormForm: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
  },
  newRepoFormP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-berry)",
  },
  newRepoFormP2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  newRepoFormDiv: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.5rem",
    paddingTop: "0.5rem",
  },
});

export type Asked<A> = QueryResult<A>;

export function Stat(props: { label: string; value: string }) {
  return (
    <div {...stylex.attrs(styles.statDiv)}>
      <span {...stylex.attrs(styles.statSpan2)}>{props.label}</span>
      <span {...stylex.attrs(styles.statSpan)}>{props.value}</span>
    </div>
  );
}

/** A thin rounded bar, filled to its share. */
function Bar(props: { share: number; color: string }) {
  return (
    <span {...stylex.attrs(styles.barSpan)}>
      <span {...stylex.attrs(styles.barSpan2)} style={{ width: `${Math.min(1, Math.max(0, props.share)) * 100}%`, background: props.color }} />
    </span>
  );
}

/** A share wide enough carries its language's picture in the bar. */
const logoInBar = 0.07;

export function Languages(props: { languages: Asked<RepoLanguages> }) {
  const data = () => ready(props.languages, undefined);
  const shares = () => {
    const d = data();
    return d ? languageShares(d.languages) : [];
  };
  return (
    <Card title={t("web.repo.whatLanguages")} action={<span {...stylex.attrs(styles.statSpan2)}>{t("web.repo.byLines")}</span>}>
      <Switch
        fallback={
          <>
            {/* Bark, not a token: the pixel logos are drawn to sit on it. */}
            <div role="img" aria-label={list(shares().map((s) => `${s.label} ${percent(s.share)}`))} {...stylex.attrs(styles.languagesDiv2)}>
              <For each={shares()}>
                {(s) => (
                  <span
                    title={`${s.label} · ${percent(s.share)}`}
                    {...stylex.attrs(styles.languagesSpan)}
                    style={{ "flex-grow": Math.max(1, Math.round(s.share * 10000)), background: s.color }}
                  >
                    <Show when={s.share >= logoInBar}>
                      <SpriteIcon name={langIcon(s.id)} size={36} />
                    </Show>
                  </span>
                )}
              </For>
            </div>
            <div {...stylex.attrs(styles.languagesDiv22)}>
              <For each={shares()}>
                {(s) => (
                  <div {...stylex.attrs(styles.languagesDiv3)}>
                    <SpriteIcon name={langIcon(s.id)} size={32} />
                    <div {...stylex.attrs(styles.languagesDiv)}>
                      <span {...stylex.attrs(styles.languagesSpan2)}>
                        <span {...stylex.attrs(styles.languagesSpan3)}>{s.label}</span>
                        <span {...stylex.attrs(styles.languagesSpan4)}>{percent(s.share)}</span>
                      </span>
                      <Bar share={s.share < 0.02 ? 0.02 : s.share} color={s.color} />
                      <span {...stylex.attrs(styles.statSpan2)}>{t("web.repo.linesAndFiles", { lines: number(s.lines), files: number(s.files) })}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </>
        }
      >
        <Match when={props.languages.error() && !data()}>
          <NotCounted reason={reasonOf(props.languages.error())} />
        </Match>
        <Match when={!data()}>
          <div {...stylex.attrs(styles.languagesDiv4)} />
        </Match>
        <Match when={shares().length === 0}>
          <Quiet>{t("web.repo.empty")}</Quiet>
        </Match>
      </Switch>
    </Card>
  );
}

function NotCounted(props: { reason: string }) {
  const install = () => props.reason.includes("brew install tokei");
  const code = (text: string) => <code {...stylex.attrs(styles.codeCode)}>{text}</code>;
  return (
    <div {...stylex.attrs(styles.notCountedDiv)}>
      <p>{install() ? t("web.repo.noTokei") : props.reason}</p>
      <Show when={install()}>
        <p {...stylex.attrs(styles.languagesSpan4)}>
          {t("web.repo.install")}
          {code("brew install tokei")}
          {t("web.repo.or")}
          {code("cargo install tokei")}
          {t("web.repo.thenRecount")}
        </p>
      </Show>
    </div>
  );
}

const levelName = (level: number) => (level === 0 || level === 1 || level === 2 || level === 3 || level === 4 ? t(`web.repo.level.${level}`) : "");

export function CommitCalendar(props: { activity: Asked<RepoActivity> }) {
  const [pointed, setPointed] = createSignal<CalendarDay>();
  const worked = () => ready(props.activity, undefined);
  const calendar = createMemo(() => calendarOf(worked()?.days ?? [], new Date()));
  const streaks = createMemo(() => streaksOf(calendar()));
  const aside = () => <span {...stylex.attrs(styles.statSpan2)}>{t("web.repo.year")}</span>;
  const line = () => {
    const p = pointed();
    const busiest = streaks().busiest;
    return p && !p.future
      ? `${dayText(p.at)} · ${p.commits > 0 ? t("web.repo.dayCommits", { n: p.commits, level: levelName(p.level) }) : t("web.repo.noCommitsThatDay")}`
      : busiest
        ? t("web.repo.busiest", { day: dayText(new Date(`${busiest.day}T12:00`)), n: busiest.commits })
        : " ";
  };
  return (
    <Show
      when={!(props.activity.error() && !worked())}
      fallback={
        <Card title={t("web.repo.calendar")} action={aside()}>
          <p {...stylex.attrs(styles.commitCalendarP)}>{reasonOf(props.activity.error())}</p>
        </Card>
      }
    >
      <Card title={t("web.repo.calendar")} action={aside()}>
        <div {...stylex.attrs(styles.commitCalendarDiv)}>
          <Stat label={t("web.repo.inYear")} value={worked() ? t("web.repo.commits", { n: number(streaks().total) }) : "…"} />
          <Stat label={t("web.repo.daysWorked")} value={worked() ? t("web.repo.days", { n: streaks().days }) : "…"} />
          <Stat label={t("web.repo.longest")} value={worked() ? t("web.repo.days", { n: streaks().longest }) : "…"} />
          <Stat label={t("web.repo.current")} value={worked() ? t("web.repo.days", { n: streaks().current }) : "…"} />
        </div>
        <div {...stylex.attrs(styles.commitCalendarDiv2)}>
          <div {...stylex.attrs(styles.commitCalendarDiv3)}>
            <div {...stylex.attrs(styles.commitCalendarDiv4)} style={{ width: `${20 + calendar().weeks.length * (tile + tileGap)}px` }}>
              <For each={calendar().months}>
                {(m) => (
                  <span {...stylex.attrs(styles.commitCalendarSpan)} style={{ left: `${20 + tileGap + m.week * (tile + tileGap)}px` }}>
                    {m.label}
                  </span>
                )}
              </For>
            </div>
            <div
              role="img"
              aria-label={worked() ? t("web.repo.yearLabel", { commits: streaks().total, days: streaks().days }) : t("web.repo.readingCommits")}
              {...stylex.attrs(styles.commitCalendarDiv5)}
              onMouseLeave={() => setPointed(undefined)}
            >
              <div {...styleProps([styles.commitCalendarDiv6, styles.calendarRows])}>
                <For each={([0, 1, 2, 3, 4, 5, 6] as const).map((i) => t(`web.repo.rows.${i}`))}>
                  {(d) => <span {...styleProps([styles.commitCalendarSpan2, styles.calendarDay])}>{d}</span>}
                </For>
              </div>
              <For each={calendar().weeks}>
                {(week) => (
                  <div {...styleProps([styles.commitCalendarDiv7, styles.calendarWeek])}>
                    <For each={week}>
                      {(d) => (
                        <span
                          onMouseEnter={() => setPointed(d)}
                          {...styleProps(d.future ? styles.calendarFuture : worked() ? styles.calendarReady : styles.calendarLoading)}
                        >
                          <SpriteIcon name={`day-${d.level}`} size={tile} />
                        </span>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
        <div {...stylex.attrs(styles.commitCalendarDiv8)}>
          <span {...stylex.attrs(styles.statSpan2)}>{line()}</span>
          <span {...stylex.attrs(styles.commitCalendarSpan3)}>
            {t("web.repo.fewer")}
            <For each={[0, 1, 2, 3, 4]}>
              {(l) => (
                <span title={levelName(l)}>
                  <SpriteIcon name={`day-${l}`} size={tile} />
                </span>
              )}
            </For>
            {t("web.repo.more")}
          </span>
        </div>
      </Card>
    </Show>
  );
}

const hands = 8;

export function Hands(props: { activity?: RepoActivity | undefined }) {
  const agents = useWorkAgents();
  const authors = () => props.activity?.authors ?? [];
  const top = () => {
    const first = authors()[0];
    return first && first.commits > 0 ? first.commits : 1;
  };
  const rest = () =>
    authors()
      .slice(hands)
      .reduce((n, a) => n + a.commits, 0);
  return (
    <Show when={authors().length > 0}>
      <Card title={t("web.repo.who")} action={<span {...stylex.attrs(styles.statSpan2)}>{t("web.repo.whoWhen")}</span>}>
        <div {...stylex.attrs(styles.handsDiv)}>
          <For each={authors().slice(0, hands)}>
            {(author) => {
              const agent = () => agents().find((a) => a.name === author.name);
              return (
                <div {...stylex.attrs(styles.languagesDiv3)}>
                  <Show when={agent()} fallback={<span {...stylex.attrs(styles.handsSpan)}>{[...author.name][0] ?? ""}</span>}>
                    {(a) => <AgentFace agentId={a().id} look={a().look} runtime={a().runtime} size={32} />}
                  </Show>
                  <div {...stylex.attrs(styles.languagesDiv)}>
                    <span {...stylex.attrs(styles.languagesSpan2)}>
                      <span {...stylex.attrs(styles.languagesSpan3)}>{author.name}</span>
                      <span {...stylex.attrs(styles.statSpan2)}>{t("web.repo.times", { n: number(author.commits) })}</span>
                    </span>
                    <Bar share={author.commits / top()} color="var(--color-leaf)" />
                  </div>
                </div>
              );
            }}
          </For>
        </div>
        <Show when={rest() > 0}>
          <p {...stylex.attrs(styles.statSpan2)}>{t("web.repo.rest", { people: authors().length - hands, commits: number(rest()) })}</p>
        </Show>
      </Card>
    </Show>
  );
}

/** The name follows the repository's until it is typed by hand; what would be refused is the server's answer. */
export function NewRepoForm(props: { onDone: (made?: RepoSummary) => void }) {
  const client = useQueryClient();
  const [importing, setImporting] = createSignal<"new" | "github">("github");
  const [github, setGithub] = createSignal("");
  const [name, setName] = createSignal("");
  const [named, setNamed] = createSignal(false);
  const [error, setError] = createSignal<string>();
  // A refusal shows in the form, beside what was typed.
  const act = createAct(setError);
  const busy = act.busy;
  const canSubmit = () => !busy() && name().trim() !== "" && (importing() === "new" || github().trim() !== "");
  const submit = async () => {
    if (!canSubmit()) return;
    const request = { name: name().trim(), ...(importing() === "github" ? { github: github().trim() } : {}) };
    const done = props.onDone;
    setError(undefined);
    await act.run(async () => {
      const problem = (await api.repo.validate(request)).problem;
      if (problem) {
        setError(problem);
        return;
      }
      const made = await api.repo.create(request);
      await client.invalidate({ prefix: ["repos"] });
      done(made);
    });
  };
  return (
    <form
      {...stylex.attrs(styles.newRepoFormForm)}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <Segmented
          label={t("web.repo.how")}
          testid="repo-how"
          value={importing()}
          options={[
            { value: "new", label: t("web.repo.fresh"), disabled: busy() },
            { value: "github", label: t("web.repo.github"), disabled: busy() },
          ]}
          onChange={(v) => {
            setImporting(v);
            setError(undefined);
          }}
        />
      </div>
      <Show when={importing() === "github"}>
        <Field label={t("web.repo.githubAddress")} hint={t("web.repo.githubHint")}>
          <TextInput
            ref={autofocus()}
            data-testid="repo-github"
            aria-label={t("web.repo.githubAddress")}
            disabled={busy()}
            placeholder={t("web.base.form.example", { value: "https://github.com/botiverse/raft-source" })}
            value={github()}
            onInput={(e) => {
              const typed = e.currentTarget.value;
              setGithub(typed);
              if (!named()) setName(githubRepository(typed)?.name ?? "");
              setError(undefined);
            }}
          />
        </Field>
      </Show>
      <Field label={t("web.repo.name")} hint={t("web.repo.nameHint")}>
        <TextInput
          data-testid="repo-name"
          aria-label={t("web.repo.name")}
          disabled={busy()}
          placeholder={t("web.repo.nameExample")}
          value={name()}
          onInput={(e) => {
            setNamed(true);
            setName(e.currentTarget.value);
            setError(undefined);
          }}
        />
      </Field>
      <Show when={error()}>
        <p role="alert" {...stylex.attrs(styles.newRepoFormP)}>
          {error()}
        </p>
      </Show>
      <Show when={busy()}>
        <p {...stylex.attrs(styles.newRepoFormP2)}>{importing() === "github" ? t("web.repo.downloading") : t("web.repo.making")}</p>
      </Show>
      <div {...stylex.attrs(styles.newRepoFormDiv)}>
        <Button disabled={busy()} data-testid="cancel" onClick={() => props.onDone()}>
          {t("web.repo.cancel")}
        </Button>
        <Button type="submit" tone="primary" data-testid="submit" disabled={!canSubmit()}>
          {busy() ? t("web.repo.busy") : importing() === "github" ? t("web.repo.download") : t("web.repo.create")}
        </Button>
      </div>
    </form>
  );
}
