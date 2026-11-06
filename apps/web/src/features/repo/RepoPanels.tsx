import { type QueryObserverResult, useQueryClient } from "@tanstack/solid-query";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";

import { list, t } from "@vibevalley/i18n";
import type { RepoActivity, RepoLanguages, RepoSummary } from "@vibevalley/protocol";
import { githubRepository } from "@vibevalley/protocol/rules";

import { autofocus } from "#/base/dom.tsx";
import { useWorkAgents } from "#/infra/agents.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { ready } from "#/infra/query.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { AgentFace } from "#/ui/Face.tsx";
import { Field, TextInput } from "#/ui/Field.tsx";
import { Card, Quiet } from "#/ui/layout.tsx";
import { SpriteIcon } from "#/ui/pixel/index.ts";
import { Segmented } from "#/ui/Segmented.tsx";

import { calendarOf, type CalendarDay, dayText, streaksOf } from "./calendar";
import { langIcon, languageShares, number, percent } from "./repos";

export type Asked<A> = QueryObserverResult<A>;

export function Stat(props: { label: string; value: string }) {
  return (
    <div class="flex min-w-18 flex-col">
      <span class="text-xs text-muted">{props.label}</span>
      <span class="line-clamp-2 text-sm font-medium">{props.value}</span>
    </div>
  );
}

/** A thin rounded bar, filled to its share. */
function Bar(props: { share: number; color: string }) {
  return (
    <span class="block h-1.5 overflow-hidden rounded-full bg-hover">
      <span class="block h-full rounded-full" style={{ width: `${Math.min(1, Math.max(0, props.share)) * 100}%`, background: props.color }} />
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
    <Card title={t("web.repo.whatLanguages")} action={<span class="text-xs text-muted">{t("web.repo.byLines")}</span>}>
      <Switch
        fallback={
          <>
            {/* Bark, not a token: the pixel logos are drawn to sit on it. */}
            <div role="img" aria-label={list(shares().map((s) => `${s.label} ${percent(s.share)}`))} class="flex h-14 overflow-hidden rounded-md bg-bark p-1">
              <For each={shares()}>
                {(s) => (
                  <span
                    title={`${s.label} · ${percent(s.share)}`}
                    class="flex min-w-1 items-center justify-center"
                    style={{ "flex-grow": Math.max(1, Math.round(s.share * 10000)), background: s.color }}
                  >
                    <Show when={s.share >= logoInBar}>
                      <SpriteIcon name={langIcon(s.id)} size={36} />
                    </Show>
                  </span>
                )}
              </For>
            </div>
            <div class="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              <For each={shares()}>
                {(s) => (
                  <div class="flex items-center gap-3">
                    <SpriteIcon name={langIcon(s.id)} size={32} />
                    <div class="flex min-w-0 flex-1 flex-col gap-1">
                      <span class="flex text-sm">
                        <span class="min-w-0 flex-1 truncate font-medium">{s.label}</span>
                        <span class="text-muted">{percent(s.share)}</span>
                      </span>
                      <Bar share={s.share < 0.02 ? 0.02 : s.share} color={s.color} />
                      <span class="text-xs text-muted">{t("web.repo.linesAndFiles", { lines: number(s.lines), files: number(s.files) })}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </>
        }
      >
        <Match when={props.languages.error && !data()}>
          <NotCounted reason={reasonOf(props.languages.error)} />
        </Match>
        <Match when={!data()}>
          <div class="h-12 rounded-md bg-hover" />
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
  const code = (text: string) => <code class="rounded bg-selected px-1.5 py-px font-mono text-sm">{text}</code>;
  return (
    <div class="flex flex-col gap-2 rounded-lg bg-hover p-3 text-sm">
      <p>{install() ? t("web.repo.noTokei") : props.reason}</p>
      <Show when={install()}>
        <p class="text-muted">
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
const tile = 12;
const tileGap = 3;

export function CommitCalendar(props: { activity: Asked<RepoActivity> }) {
  const [pointed, setPointed] = createSignal<CalendarDay>();
  const worked = () => ready(props.activity, undefined);
  const calendar = createMemo(() => calendarOf(worked()?.days ?? [], new Date()));
  const streaks = createMemo(() => streaksOf(calendar()));
  const aside = () => <span class="text-xs text-muted">{t("web.repo.year")}</span>;
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
      when={!(props.activity.error && !worked())}
      fallback={
        <Card title={t("web.repo.calendar")} action={aside()}>
          <p class="text-sm">{reasonOf(props.activity.error)}</p>
        </Card>
      }
    >
      <Card title={t("web.repo.calendar")} action={aside()}>
        <div class="grid grid-cols-4 gap-6">
          <Stat label={t("web.repo.inYear")} value={worked() ? t("web.repo.commits", { n: number(streaks().total) }) : "…"} />
          <Stat label={t("web.repo.daysWorked")} value={worked() ? t("web.repo.days", { n: streaks().days }) : "…"} />
          <Stat label={t("web.repo.longest")} value={worked() ? t("web.repo.days", { n: streaks().longest }) : "…"} />
          <Stat label={t("web.repo.current")} value={worked() ? t("web.repo.days", { n: streaks().current }) : "…"} />
        </div>
        <div class="overflow-x-auto pb-1">
          <div class="min-w-[704px]">
            <div class="relative h-4" style={{ width: `${20 + calendar().weeks.length * (tile + tileGap)}px` }}>
              <For each={calendar().months}>
                {(m) => (
                  <span class="absolute top-0 text-xs text-muted" style={{ left: `${20 + tileGap + m.week * (tile + tileGap)}px` }}>
                    {m.label}
                  </span>
                )}
              </For>
            </div>
            <div
              role="img"
              aria-label={worked() ? t("web.repo.yearLabel", { commits: streaks().total, days: streaks().days }) : t("web.repo.readingCommits")}
              class="mt-1 flex"
              onMouseLeave={() => setPointed(undefined)}
            >
              <div class="flex w-5 flex-col" style={{ gap: `${tileGap}px` }}>
                <For each={([0, 1, 2, 3, 4, 5, 6] as const).map((i) => t(`web.repo.rows.${i}`))}>
                  {(d) => (
                    <span class="flex items-center text-2xs leading-none text-muted" style={{ height: `${tile}px` }}>
                      {d}
                    </span>
                  )}
                </For>
              </div>
              <For each={calendar().weeks}>
                {(week) => (
                  <div class="flex flex-col" style={{ gap: `${tileGap}px`, "margin-left": `${tileGap}px` }}>
                    <For each={week}>
                      {(d) => (
                        <span onMouseEnter={() => setPointed(d)} style={{ opacity: d.future ? 0 : worked() ? 1 : 0.5 }}>
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
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs text-muted">{line()}</span>
          <span class="flex items-center gap-1 text-xs text-muted">
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
      <Card title={t("web.repo.who")} action={<span class="text-xs text-muted">{t("web.repo.whoWhen")}</span>}>
        <div class="grid gap-2.5 sm:grid-cols-2">
          <For each={authors().slice(0, hands)}>
            {(author) => {
              const agent = () => agents().find((a) => a.name === author.name);
              return (
                <div class="flex items-center gap-3">
                  <Show
                    when={agent()}
                    fallback={
                      <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-selected text-sm font-medium">
                        {[...author.name][0] ?? ""}
                      </span>
                    }
                  >
                    {(a) => <AgentFace agentId={a().id} look={a().look} runtime={a().runtime} size={32} />}
                  </Show>
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <span class="flex text-sm">
                      <span class="min-w-0 flex-1 truncate font-medium">{author.name}</span>
                      <span class="text-xs text-muted">{t("web.repo.times", { n: number(author.commits) })}</span>
                    </span>
                    <Bar share={author.commits / top()} color="#74a046" />
                  </div>
                </div>
              );
            }}
          </For>
        </div>
        <Show when={rest() > 0}>
          <p class="text-xs text-muted">{t("web.repo.rest", { people: authors().length - hands, commits: number(rest()) })}</p>
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
      await client.invalidateQueries({ queryKey: ["repos"] });
      done(made);
    });
  };
  return (
    <form
      class="flex flex-col gap-4"
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
        <p role="alert" class="text-sm text-berry">
          {error()}
        </p>
      </Show>
      <Show when={busy()}>
        <p class="text-sm text-muted">{importing() === "github" ? t("web.repo.downloading") : t("web.repo.making")}</p>
      </Show>
      <div class="flex justify-end gap-2 pt-2">
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
