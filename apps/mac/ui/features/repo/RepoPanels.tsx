import { Scroll, signal, Text, View, type JSX } from "nsh";

import { list, t } from "@vibevalley/i18n";
import type { RepoActivity, RepoLanguages, RepoSummary } from "@vibevalley/protocol";
import { githubRepository } from "@vibevalley/protocol/rules";

import { Button } from "../../design/Button";
import { Checkbox } from "../../design/Checkbox";
import { AgentFace } from "../../design/domain/Face";
import { Field, TextInput } from "../../design/Field";
import { Card, Quiet } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { Bubble } from "../../design/Tip";
import { mix } from "../../design/tone";
import { createAct } from "../../infra/act";
import { useWorkAgents } from "../../infra/agents";
import { api, reasonOf } from "../../infra/api";
import { hostApi } from "../../infra/bridge";
import { type QueryResult, ready, useQueryClient } from "../../infra/query";
import { languageShares, number, percent } from "../../infra/repos";
import { createMemo, untrack } from "../../infra/solid";
import { calendarOf, type CalendarDay, dayText, streaksOf } from "./calendar";

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

/** A language's colour swatch. */
function LangMark(props: { color: string; size: number }) {
  return <View class="shrink-0 rounded-sm border border-line" style={{ width: props.size, height: props.size, backgroundColor: props.color }} />;
}

/** A calendar day's tile shaded by commit activity level. */
function DayTile(props: { level: number }) {
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
            <View
              role="image"
              accessibilityLabel={list(shares().map((s) => `${s.label} ${percent(s.share)}`))}
              class="h-14 flex-row gap-px overflow-hidden rounded-md border border-line bg-side p-1"
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
                    <LangMark color={s().color} size={28} />
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
  return (
    <View class="gap-2 rounded-lg bg-hover p-3">
      <Text class="text-sm text-ink">{props.reason}</Text>
    </View>
  );
}

const levelName = (level: number) => (level === 0 || level === 1 || level === 2 || level === 3 || level === 4 ? t(`web.repo.level.${level}`) : "");

export function CommitCalendar(props: { activity: Asked<RepoActivity> }) {
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
                          <DayTile level={d().level} />
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
                  <DayTile level={l()} />
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

/** Creates a managed repo (empty or GitHub clone) or mounts an existing local directory. */
export function NewRepoForm(props: { initialMode?: "local" | "new" | "github" | undefined; onDone: (made?: RepoSummary) => void }) {
  const client = useQueryClient();
  const importing = signal<"local" | "new" | "github">(untrack(() => props.initialMode ?? "github"));
  const github = signal("");
  const localPath = signal("");
  const initGit = signal(false);
  const name = signal("");
  const named = signal(false);
  const error = signal<string | undefined>(undefined);
  // A refusal shows in the form, beside what was typed.
  const act = createAct((reason) => error.set(reason));
  const busy = act.busy;
  const canSubmit = createMemo(() => {
    if (busy()) return false;
    if (importing() === "local") return localPath().trim() !== "";
    return name().trim() !== "" && (importing() === "new" || github().trim() !== "");
  });
  const pickLocalFolder = async () => {
    error.set(undefined);
    const got = await hostApi.pickFolder();
    if (got.bizCode !== 0 || !got.data) return;
    localPath.set(got.data.path);
    initGit.set(!got.data.git);
    if (!named() && got.data.name) name.set(got.data.name);
  };
  const submit = async () => {
    if (!canSubmit()) return;
    const done = props.onDone;
    error.set(undefined);
    await act.run(async () => {
      if (importing() === "local") {
        const trimmedName = name().trim();
        const made = await api.repo.mount({
          path: localPath().trim(),
          ...(trimmedName ? { name: trimmedName } : {}),
          ...(initGit() ? { initGit: true } : {}),
        });
        await client.invalidate({ prefix: ["repos"] });
        done(made);
        return;
      }
      const request = { name: name().trim(), ...(importing() === "github" ? { github: github().trim() } : {}) };
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
    <View class="min-h-0 flex-1">
      <Scroll class="min-h-0 flex-1" contentClass="gap-4 px-5 py-4">
        <Segmented
          label={t("web.repo.how")}
          testid="repo-how"
          value={importing()}
          options={[
            { value: "local", label: t("web.repo.local"), disabled: busy() },
            { value: "new", label: t("web.repo.fresh"), disabled: busy() },
            { value: "github", label: t("web.repo.github"), disabled: busy() },
          ]}
          onChange={(v) => {
            importing.set(v);
            error.set(undefined);
          }}
        />
        <If when={importing() === "local"}>
          <Field label={t("web.repo.localPath")} hint={t("web.repo.localPathHint")}>
            <View class="flex-row items-center gap-2">
              <TextInput
                autoFocus
                wide={false}
                class="min-w-0 flex-1"
                testID="repo-local-path"
                accessibilityLabel={t("web.repo.localPath")}
                disabled={busy()}
                placeholder={t("web.repo.localPathPlaceholder")}
                value={localPath()}
                onInput={(typed) => {
                  localPath.set(typed);
                  if (!named()) {
                    const base = typed.replace(/\/+$/u, "").split("/").pop() ?? "";
                    name.set(base);
                  }
                  error.set(undefined);
                }}
                onSubmit={() => void submit()}
              />
              <Button icon="folder" testID="repo-pick-folder" disabled={busy()} onPress={() => void pickLocalFolder()}>
                {t("web.repo.pickFolder")}
              </Button>
            </View>
          </Field>
          <View class="flex-row items-start gap-2">
            <Checkbox checked={initGit()} onChange={(v) => initGit.set(v)} label={t("web.repo.initGit")} disabled={busy()} testid="repo-init-git" />
            <View class="min-w-0 flex-1 gap-0.5">
              <Text class="text-sm text-ink">{t("web.repo.initGit")}</Text>
              <Text class="text-xs text-muted">{t("web.repo.initGitHint")}</Text>
            </View>
          </View>
        </If>
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
        <Field label={t("web.repo.name")} hint={importing() === "local" ? t("web.repo.nameOptionalHint") : t("web.repo.nameHint")}>
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
          <Text class="text-sm text-muted">
            {importing() === "github" ? t("web.repo.downloading") : importing() === "local" ? t("web.repo.mounting") : t("web.repo.making")}
          </Text>
        </If>
      </Scroll>
      <View class="shrink-0 flex-row justify-end gap-2 border-t border-line px-5 py-3">
        <Button tone="quiet" disabled={busy()} testID="cancel" onPress={() => props.onDone()}>
          {t("web.repo.cancel")}
        </Button>
        <Button tone="primary" testID="submit" disabled={!canSubmit()} onPress={() => void submit()}>
          {busy()
            ? t("web.repo.busy")
            : importing() === "github"
              ? t("web.repo.download")
              : importing() === "local"
                ? t("web.repo.mount")
                : t("web.repo.create")}
        </Button>
      </View>
    </View>
  );
}
