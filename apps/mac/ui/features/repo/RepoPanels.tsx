import { Image, Scroll, signal, Text, View, type JSX } from "nsh";

import { list, t } from "@vibevalley/i18n";
import type { RepoActivity, RepoLanguages, RepoSummary } from "@vibevalley/protocol";
import { githubRepository } from "@vibevalley/protocol/rules";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { AgentFace } from "../../design/domain/Face";
import { Field, TextInput } from "../../design/Field";
import { Card, Quiet } from "../../design/layout";
import { spriteUrl, usePixelDir } from "../../design/pixel/atlas";
import { SpriteOr } from "../../design/pixel/icons";
import { Segmented } from "../../design/Segmented";
import { Bubble } from "../../design/Tip";
import { mix } from "../../design/tone";
import { useWorkAgents } from "../../infra/agents";
import { api, reasonOf } from "../../infra/api";
import { type QueryResult, ready, useQueryClient } from "../../infra/query";
import { createMemo } from "../../infra/solid";
import { calendarOf, type CalendarDay, dayText, streaksOf } from "./calendar";
import { langIcon, languageShares, number, percent } from "./repos";

const tile = 12;
const tileGap = 3;

export type Asked<A> = QueryResult<A>;

export function Stat(props: { label: string; value: string }) {
  return (
    <View class="min-w-18 gap-0.5">
      <Text class="text-xs text-muted">{props.label}</Text>
      <Text class="line-clamp-2 text-sm font-medium tabular-nums text-ink">{props.value}</Text>
    </View>
  );
}

/** A thin rounded bar, filled to its share. */
function Bar(props: { share: number; color: string }) {
  return (
    <View class="h-1.5 overflow-hidden rounded-full bg-hover">
      <View class="h-full rounded-full" style={{ width: `${Math.min(1, Math.max(0, props.share)) * 100}%`, backgroundColor: props.color }} />
    </View>
  );
}

/** A language's mark: its colour, where VibeValley draws its pixel logo. */
function LangMark(props: { color: string; size: number }) {
  return <View class="shrink-0 rounded-sm border border-line" style={{ width: props.size, height: props.size, backgroundColor: props.color }} />;
}

/** A calendar day's tile: bare to in flower in the leaf's shades. */
function DayTile(props: { level: number; dir: string | undefined }) {
  // A year of tiles: one folder lookup for the calendar (props.dir), not one query per tile.
  return (
    <If when={props.dir} else={<DayStandIn level={props.level} />}>
      {(dir) => <Image src={spriteUrl(dir(), `day-${props.level}`)} style={{ width: tile, height: tile }} />}
    </If>
  );
}

function DayStandIn(props: { level: number }) {
  return (
    <View
      class="rounded-xs"
      style={{ width: tile, height: tile, backgroundColor: props.level <= 0 ? mix("line", 1) : mix("leaf", [0, 0.3, 0.5, 0.75, 1][props.level] ?? 1) }}
    />
  );
}

export function Languages(props: { languages: Asked<RepoLanguages> }) {
  const data = () => ready(props.languages, undefined);
  const shares = createMemo(() => {
    const d = data();
    return d ? languageShares(d.languages) : [];
  });
  return (
    <Card title={t("web.repo.whatLanguages")} action={<Text class="text-xs text-muted">{t("web.repo.byLines")}</Text>}>
      <If when={!(props.languages.error() && !data())} else={<NotCounted reason={reasonOf(props.languages.error())} />}>
        <If when={data()} else={<View class="h-12 rounded-md bg-hover" />}>
          <If when={shares().length > 0} else={<Quiet>{t("web.repo.empty")}</Quiet>}>
            {/* Bark, not a token: the pixel logos are drawn to sit on it. */}
            <View
              role="image"
              accessibilityLabel={list(shares().map((s) => `${s.label} ${percent(s.share)}`))}
              class="h-14 flex-row gap-px overflow-hidden rounded-md bg-bark p-1"
            >
              <Each of={shares()} key={(s) => s.label}>
                {(s) => (
                  <View
                    tooltip={<Bubble text={`${s().label} · ${percent(s().share)}`} />}
                    class="min-w-1 rounded-xs"
                    style={{ flexGrow: Math.max(1, Math.round(s().share * 10000)), flexBasis: 0, backgroundColor: s().color }}
                  />
                )}
              </Each>
            </View>
            <View class="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
              <Each of={shares()} key={(s) => s.label}>
                {(s) => (
                  <View class="flex-row items-center gap-3">
                    <SpriteOr name={langIcon(s().id)} size={32}>
                      <LangMark color={s().color} size={32} />
                    </SpriteOr>
                    <View class="min-w-0 flex-1 gap-1">
                      <View class="flex-row items-baseline gap-2">
                        <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{s().label}</Text>
                        <Text class="text-sm tabular-nums text-muted">{percent(s().share)}</Text>
                      </View>
                      <Bar share={s().share < 0.02 ? 0.02 : s().share} color={s().color} />
                      <Text class="text-xs tabular-nums text-muted">{t("web.repo.linesAndFiles", { lines: number(s().lines), files: number(s().files) })}</Text>
                    </View>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </If>
      </If>
    </Card>
  );
}

function NotCounted(props: { reason: string }) {
  const install = () => props.reason.includes("brew install tokei");
  const code = (text: string) => <Text class="rounded-sm bg-selected px-1.5 py-px font-mono text-sm text-ink">{text}</Text>;
  return (
    <View class="gap-2 rounded-lg bg-hover p-3">
      <Text class="text-sm text-ink">{install() ? t("web.repo.noTokei") : props.reason}</Text>
      <If when={install()}>
        <Text class="text-sm text-muted">
          {t("web.repo.install")}
          {code("brew install tokei")}
          {t("web.repo.or")}
          {code("cargo install tokei")}
          {t("web.repo.thenRecount")}
        </Text>
      </If>
    </View>
  );
}

const levelName = (level: number) => (level === 0 || level === 1 || level === 2 || level === 3 || level === 4 ? t(`web.repo.level.${level}`) : "");

export function CommitCalendar(props: { activity: Asked<RepoActivity> }) {
  const pixelDir = usePixelDir();
  const pointed = signal<CalendarDay | undefined>(undefined);
  const worked = () => ready(props.activity, undefined);
  const calendar = createMemo(() => calendarOf(worked()?.days ?? [], new Date()));
  const streaks = createMemo(() => streaksOf(calendar()));
  const aside = () => <Text class="text-xs text-muted">{t("web.repo.year")}</Text>;
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
    <If
      when={!(props.activity.error() && !worked())}
      else={
        <Card title={t("web.repo.calendar")} action={aside()}>
          <Text class="text-sm text-ink">{reasonOf(props.activity.error())}</Text>
        </Card>
      }
    >
      <Card title={t("web.repo.calendar")} action={aside()} testid="repo-calendar">
        <View class="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label={t("web.repo.inYear")} value={worked() ? t("web.repo.commits", { n: number(streaks().total) }) : "…"} />
          <Stat label={t("web.repo.daysWorked")} value={worked() ? t("web.repo.days", { n: streaks().days }) : "…"} />
          <Stat label={t("web.repo.longest")} value={worked() ? t("web.repo.days", { n: streaks().longest }) : "…"} />
          <Stat label={t("web.repo.current")} value={worked() ? t("web.repo.days", { n: streaks().current }) : "…"} />
        </View>
        <ScrollRow>
          <View class="min-w-176">
            <View class="h-4" style={{ width: 20 + calendar().weeks.length * (tile + tileGap) }}>
              <Each of={calendar().months}>
                {(m) => (
                  <Text class="absolute top-0 text-xs text-muted" style={{ left: 20 + tileGap + m().week * (tile + tileGap) }}>
                    {m().label}
                  </Text>
                )}
              </Each>
            </View>
            <View
              role="image"
              accessibilityLabel={worked() ? t("web.repo.yearLabel", { commits: streaks().total, days: streaks().days }) : t("web.repo.readingCommits")}
              class="mt-1 flex-row"
              onMouseLeave={() => pointed.set(undefined)}
            >
              <View class="w-5 gap-0.75">
                <Each of={([0, 1, 2, 3, 4, 5, 6] as const).map((i) => t(`web.repo.rows.${i}`))}>
                  {(d) => (
                    <View class="h-3 justify-center">
                      <Text class="text-2xs leading-none text-muted">{d()}</Text>
                    </View>
                  )}
                </Each>
              </View>
              <Each of={calendar().weeks}>
                {(week) => (
                  <View class="ml-0.75 gap-0.75">
                    <Each of={week()}>
                      {(d) => (
                        <View onMouseEnter={() => pointed.set(d())} style={{ opacity: d().future ? 0 : worked() ? 1 : 0.5 }}>
                          <DayTile level={d().level} dir={pixelDir()} />
                        </View>
                      )}
                    </Each>
                  </View>
                )}
              </Each>
            </View>
          </View>
        </ScrollRow>
        <View class="flex-row flex-wrap items-center justify-between gap-2">
          <Text class="text-xs tabular-nums text-muted">{line()}</Text>
          <View class="flex-row items-center gap-1">
            <Text class="text-xs text-muted">{t("web.repo.fewer")}</Text>
            <Each of={[0, 1, 2, 3, 4]}>
              {(l) => (
                <View tooltip={<Bubble text={levelName(l())} />}>
                  <DayTile level={l()} dir={pixelDir()} />
                </View>
              )}
            </Each>
            <Text class="text-xs text-muted">{t("web.repo.more")}</Text>
          </View>
        </View>
      </Card>
    </If>
  );
}

function ScrollRow(props: { children: JSX.Element }) {
  return (
    <Scroll horizontal class="pb-1">
      {props.children}
    </Scroll>
  );
}

const hands = 8;

export function Hands(props: { activity?: RepoActivity | undefined }) {
  const agents = useWorkAgents();
  const agentByName = createMemo(() => new Map(agents().map((a) => [a.name, a])));
  const authors = () => props.activity?.authors ?? [];
  const shownAuthors = createMemo(() => authors().slice(0, hands));
  const top = createMemo(() => {
    const first = authors().at(0);
    return first !== undefined && first.commits > 0 ? first.commits : 1;
  });
  const rest = createMemo(() =>
    authors()
      .slice(hands)
      .reduce((n, a) => n + a.commits, 0),
  );
  return (
    <If when={authors().length > 0}>
      <Card title={t("web.repo.who")} action={<Text class="text-xs text-muted">{t("web.repo.whoWhen")}</Text>} testid="repo-hands">
        <View class="grid gap-2.5 sm:grid-cols-2">
          <Each of={shownAuthors()} key={(a) => a.name}>
            {(author) => {
              const agent = createMemo(() => agentByName().get(author().name));
              return (
                <View class="flex-row items-center gap-3">
                  <If
                    when={agent()}
                    else={
                      <View class="h-8 w-8 shrink-0 items-center justify-center rounded-full bg-selected">
                        <Text class="text-sm font-medium text-ink">{[...author().name][0] ?? ""}</Text>
                      </View>
                    }
                  >
                    {(a) => <AgentFace agentId={a().id} name={a().name} look={a().look} runtime={a().runtime} size={32} />}
                  </If>
                  <View class="min-w-0 flex-1 gap-1">
                    <View class="flex-row items-baseline gap-2">
                      <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{author().name}</Text>
                      <Text class="text-xs tabular-nums text-muted">{t("web.repo.times", { n: number(author().commits) })}</Text>
                    </View>
                    <Bar share={author().commits / top()} color={mix("leaf", 1)} />
                  </View>
                </View>
              );
            }}
          </Each>
        </View>
        <If when={rest() > 0}>
          <Text class="text-xs tabular-nums text-muted">{t("web.repo.rest", { people: authors().length - hands, commits: number(rest()) })}</Text>
        </If>
      </Card>
    </If>
  );
}

/** The name follows the repository's until it is typed by hand; what would be refused is the server's answer. */
export function NewRepoForm(props: { onDone: (made?: RepoSummary) => void }) {
  const client = useQueryClient();
  const importing = signal<"new" | "github">("github");
  const github = signal("");
  const name = signal("");
  const named = signal(false);
  const error = signal<string | undefined>(undefined);
  // A refusal shows in the form, beside what was typed.
  const act = createAct((reason) => error.set(reason));
  const busy = act.busy;
  const canSubmit = createMemo(() => !busy() && name().trim() !== "" && (importing() === "new" || github().trim() !== ""));
  const submit = async () => {
    if (!canSubmit()) return;
    const request = { name: name().trim(), ...(importing() === "github" ? { github: github().trim() } : {}) };
    const done = props.onDone;
    error.set(undefined);
    await act.run(async () => {
      const problem = (await api.repo.validate(request)).problem;
      if (problem) {
        error.set(problem);
        return;
      }
      const made = await api.repo.create(request);
      await client.invalidate({ prefix: ["repos"] });
      done(made);
    });
  };
  return (
    <View class="gap-4">
      <Segmented
        label={t("web.repo.how")}
        testid="repo-how"
        value={importing()}
        options={[
          { value: "new", label: t("web.repo.fresh"), disabled: busy() },
          { value: "github", label: t("web.repo.github"), disabled: busy() },
        ]}
        onChange={(v) => {
          importing.set(v);
          error.set(undefined);
        }}
      />
      <If when={importing() === "github"}>
        <Field label={t("web.repo.githubAddress")} hint={t("web.repo.githubHint")}>
          <TextInput
            autoFocus
            testID="repo-github"
            accessibilityLabel={t("web.repo.githubAddress")}
            disabled={busy()}
            placeholder={t("web.base.form.example", { value: "https://github.com/botiverse/raft-source" })}
            value={github()}
            onInput={(typed) => {
              github.set(typed);
              if (!named()) name.set(githubRepository(typed)?.name ?? "");
              error.set(undefined);
            }}
            onSubmit={() => void submit()}
          />
        </Field>
      </If>
      <Field label={t("web.repo.name")} hint={t("web.repo.nameHint")}>
        <TextInput
          testID="repo-name"
          accessibilityLabel={t("web.repo.name")}
          disabled={busy()}
          placeholder={t("web.repo.nameExample")}
          value={name()}
          onInput={(typed) => {
            named.set(true);
            name.set(typed);
            error.set(undefined);
          }}
          onSubmit={() => void submit()}
        />
      </Field>
      <If when={error()}>
        <Text role="alert" class="text-sm text-berry">
          {error()}
        </Text>
      </If>
      <If when={busy()}>
        <Text class="text-sm text-muted">{importing() === "github" ? t("web.repo.downloading") : t("web.repo.making")}</Text>
      </If>
      <View class="flex-row justify-end gap-2 border-t border-line pt-3">
        <Button tone="quiet" disabled={busy()} testID="cancel" onPress={() => props.onDone()}>
          {t("web.repo.cancel")}
        </Button>
        <Button tone="primary" testID="submit" disabled={!canSubmit()} onPress={() => void submit()}>
          {busy() ? t("web.repo.busy") : importing() === "github" ? t("web.repo.download") : t("web.repo.create")}
        </Button>
      </View>
    </View>
  );
}
