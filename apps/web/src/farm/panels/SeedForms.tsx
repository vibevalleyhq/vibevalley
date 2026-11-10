import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type RepoTemplates, type Session } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { aria } from "#/base/dom.tsx";
import { commands } from "#/farm/frames.ts";
import { farmRepo } from "#/farm/store.ts";
import { issueOf } from "#/farm/world/plots.ts";
import { createWriteKey, writeIssue } from "#/features/issue/index.ts";
import { useWorkAgents } from "#/infra/agents.ts";
import { api, reasonOf, newSendKey } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { defineQuery, retryRead, ready, useRepos, useQuery } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { usePrefs } from "#/state/prefs.ts";
import { AgentFace } from "#/ui/Face.tsx";
import { createPixelAct, PxButton, PxTextArea, SpriteIcon, toasts, ToastType } from "#/ui/pixel/index.ts";
import { playSound } from "#/ui/pixel/sound.ts";

const styles = stylex.create({
  whoTileButton: {
    display: "flex",
    width: "calc(var(--spacing) * 16)",
    cursor: "pointer",
    flexDirection: "column",
    alignItems: "center",
    paddingBlock: "var(--spacing)",
  },
  whoTileButtonPrimary: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-200)",
      },
    },
  },
  whoTileButtonSecondary: {
    backgroundColor: {
      default: "var(--color-px-leaf-strong)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-leaf-300) 70%, transparent)",
    },
  },
  sowFormButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "var(--spacing)",
    borderStyle: "solid",
    borderWidth: "2px",
    paddingBlock: "calc(var(--spacing) * .5)",
    paddingRight: "calc(var(--spacing) * 2)",
    paddingLeft: "var(--spacing)",
    fontSize: "12px",
  },
  sowFormButtonPrimary: {
    borderColor: "transparent",
    color: "var(--color-bark-800)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-200)",
      },
    },
  },
  sowFormButtonSecondary: {
    borderColor: "var(--color-leaf-500)",
    color: "var(--color-bark-900)",
    backgroundColor: {
      default: "var(--color-px-leaf-wash)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-leaf-300) 60%, transparent)",
    },
  },
  sowFormP: {
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  sowFormSpan: {
    marginLeft: "calc(var(--spacing) * 2)",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  sowFormP2: {
    marginTop: "calc(var(--spacing) * 2.5)",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  sowFormP3: {
    marginTop: "calc(var(--spacing) * 3)",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  sowFormP4: {
    minWidth: "0",
    flex: "1",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  waterFormP: {
    marginTop: "var(--spacing)",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  chipButton: {
    cursor: "pointer",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "var(--spacing)",
    fontSize: "12px",
  },
  chipButtonTone: {
    backgroundColor: "var(--color-leaf-500)",
    color: "var(--color-bark-900)",
  },
  chipButtonAlt: {
    backgroundColor: {
      default: "var(--color-cream-200)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-300)",
      },
    },
    color: "var(--color-bark-800)",
  },
  whoTileSpan: {
    marginTop: "calc(var(--spacing) * .5)",
    maxWidth: "60px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "12px",
    color: "var(--color-bark-800)",
  },
  sowHomeless: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 2.5)",
  },
  sowFormP5: {
    fontSize: "14px",
    color: "var(--color-bark-900)",
  },
  sowForm: {
    display: "flex",
    flexDirection: "column",
  },
  sowFormDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  sowFormP22: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "14px",
    color: "var(--color-bark-900)",
  },
  sowFormDiv2: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "flex",
    flexDirection: "column",
  },
  sowFormDiv3: {
    marginTop: "calc(var(--spacing) * 2.5)",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  sowFormP32: {
    fontSize: "12px",
    color: "var(--color-berry)",
  },
  sowFormDiv4: {
    marginTop: "calc(var(--spacing) * 1.5)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 1.5)",
  },
  seedKinds: {
    marginTop: "calc(var(--spacing) * 1.5)",
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--spacing)",
  },
  sowFormDiv5: {
    marginTop: "calc(var(--spacing) * 1.5)",
  },
  sowFormSpan2: {
    display: "flex",
    height: "calc(var(--spacing) * 11)",
    width: "calc(var(--spacing) * 11)",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "var(--color-cream-200)",
    fontSize: "16px",
    color: "var(--color-bark-600)",
  },
  sowFormDiv6: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  sowFormP42: {
    marginTop: "calc(var(--spacing) * 1.5)",
    fontSize: "12px",
    color: "var(--color-berry)",
  },
  waterFormP2: {
    fontSize: "13px",
    color: "var(--color-bark-800)",
  },
  waterFormDiv: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 1.5)",
  },
  waterFormDiv2: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "flex",
    alignItems: "flex-end",
    gap: "calc(var(--spacing) * 2)",
  },
  waterFormDiv3: {
    flex: "1",
  },
  waterFormP22: {
    marginTop: "calc(var(--spacing) * 1.5)",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
});

const repoTemplatesQuery = defineQuery({
  schema: S.RepoTemplates,
  key: (id: string) => ["templates", id],
  fetch: (id, context) => api.repo.template.list({ id }, context),
  ...retryRead,
});

/** Who picks the helper when the user does not. */
const byOrchestrator = "auto";

/** The bag's seeds: the recent words, and each kind that has templates, with them. */
function seedsOf(bag: RepoTemplates | undefined) {
  return {
    recent: bag?.recent ?? [],
    kinds: (bag?.kinds ?? []).flatMap((k) => (k.templates.length > 0 ? [{ kind: k, templates: k.templates }] : [])),
  };
}

function Chip(props: { text: string; on: boolean; onClick: () => void; testid: string; item?: string }) {
  return (
    <button
      type="button"
      data-testid={props.testid}
      data-key={props.item}
      aria-pressed={aria(props.on)}
      onClick={() => props.onClick()}
      {...stylex.attrs(styles.chipButton, props.on ? styles.chipButtonTone : styles.chipButtonAlt)}
    >
      {props.text}
    </button>
  );
}

function WhoTile(props: { active: boolean; label: string; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      aria-pressed={aria(props.active)}
      aria-label={props.label}
      onClick={() => props.onClick()}
      {...stylex.attrs(styles.whoTileButton, props.active ? styles.whoTileButtonSecondary : styles.whoTileButtonPrimary)}
    >
      {props.children}
      <span {...stylex.attrs(styles.whoTileSpan)}>{props.label}</span>
    </button>
  );
}

export function SowForm(props: { station: number; onDone: () => void }) {
  const reposQuery = useRepos();
  const repos = () => ready(reposQuery, []).map((p) => p.name);
  // Every plot here is sown in this farm's repo.
  const repo = () => farmRepo() || undefined;
  const pick = usePrefs((p) => p.pick);
  const agents = useWorkAgents(true);
  const router = useRouter();
  const [text, setText] = createSignal("");
  const [selection, setSelection] = createSignal<readonly [number, number]>();
  const [who, setWho] = createSignal<string>();
  const [refused, setRefused] = createSignal<string>();
  const act = createPixelAct();
  // The form's: it closes once it sowed, so a sowing sent again is only ever this one.
  const sowKey = newSendKey();
  const writeKey = createWriteKey();
  let words: HTMLTextAreaElement | undefined;

  const templates = useQuery(() => repoTemplatesQuery(repo() ?? ""), { enabled: () => !!repo() });
  const sower = () => who() ?? (agents().some((a) => a.id === pick()) ? pick() : byOrchestrator);
  const agentOf = (w: string) => (w === byOrchestrator ? undefined : w);
  const canSow = () => text().trim() !== "";

  const take = (t: string, blank?: { start: number; end: number }) => {
    setText(t);
    setSelection(blank ? [blank.start, blank.end] : undefined);
    words?.focus();
  };
  const sow = () => {
    const p = repo();
    if (!canSow() || !p) return;
    playSound("plant");
    // The form closes at once; a refusal is said in a toast.
    const sowing = omitUndefined({ station: props.station, agent: agentOf(sower()), repo: p });
    const said = text();
    void act.run(() => commands.plant(said, sowKey, sowing));
    props.onDone();
  };
  const write = async () => {
    const p = repo();
    if (!canSow() || !p) return;
    try {
      const words = text().trim();
      const got = await writeIssue(text(), agentOf(sower()) ?? "", p, writeKey.for(words));
      writeKey.used();
      if (got.refused) toasts.add({ type: ToastType.info, title: t("web.farm.sow.notDrafted"), description: got.refused });
      props.onDone();
      router.navigate(`/issues/${encodeURIComponent(got.issue.id)}`);
    } catch (e) {
      setRefused(reasonOf(e));
    }
  };
  const bag = () => ready(templates, undefined);
  const seeds = () => seedsOf(bag());
  const [kindId, setKindId] = createSignal<string>();
  // The kind picked, else the first.
  const kind = () => seeds().kinds.find((k) => k.kind.id === kindId()) ?? seeds().kinds[0];

  return (
    <Show
      when={repo()}
      fallback={
        <div data-testid="sow-homeless" {...stylex.attrs(styles.sowHomeless)}>
          <p {...stylex.attrs(styles.sowFormP5)}>{t("web.farm.sow.homeless")}</p>
          <p {...stylex.attrs(styles.sowFormP)}>{repos().length > 0 ? t("web.farm.sow.toMap") : t("web.farm.sow.noRepos")}</p>
          <PxButton tone="primary" data-testid="sow-to-map" onClick={() => (props.onDone(), router.navigate("/repos"))}>
            {repos().length > 0 ? t("web.farm.sow.map") : t("web.farm.sow.makeRepo")}
          </PxButton>
        </div>
      }
    >
      {(p) => (
        <div data-testid="sow-form" data-repo={p()} {...stylex.attrs(styles.sowForm)}>
          <div {...stylex.attrs(styles.sowFormDiv)}>
            <p {...stylex.attrs(styles.sowFormP22)}>
              {t("web.farm.sow.plantIn", { repo: p() })}
              <Show when={bag()?.stack.label}>
                <span {...stylex.attrs(styles.sowFormSpan)}>{bag()!.stack.label}</span>
              </Show>
            </p>
          </div>
          <div {...stylex.attrs(styles.sowFormDiv2)}>
            <Switch>
              <Match when={templates.status() === "pending" && !!repo()}>
                <p {...stylex.attrs(styles.sowFormP2)}>{t("web.farm.sow.rummaging")}</p>
              </Match>
              <Match when={templates.error()}>
                {(e) => (
                  <div {...stylex.attrs(styles.sowFormDiv3)}>
                    <p role="alert" {...stylex.attrs(styles.sowFormP32)}>
                      {t("web.farm.sow.noSeeds")}
                      {reasonOf(e())}
                    </p>
                    <PxButton size="sm" data-testid="seeds-retry" disabled={templates.fetching()} onClick={() => void templates.refetch()}>
                      {t("web.farm.sow.retry")}
                    </PxButton>
                  </div>
                )}
              </Match>
            </Switch>
            <Show when={seeds().recent.length > 0}>
              <p {...stylex.attrs(styles.sowFormP2)}>{t("web.farm.sow.recent")}</p>
              <div {...stylex.attrs(styles.sowFormDiv4)}>
                <For each={seeds().recent}>{(r) => <Chip testid="seed-recent" text={r} on={text() === r} onClick={() => take(r)} />}</For>
              </div>
            </Show>
            <Show when={seeds().kinds.length > 0}>
              <p {...stylex.attrs(styles.sowFormP2)}>{t("web.farm.sow.kinds")}</p>
              {/* One kind at a time: its tab, then its seeds. */}
              <div role="tablist" aria-label={t("web.farm.sow.kinds")} data-testid="seed-kinds" {...stylex.attrs(styles.seedKinds)}>
                <For each={seeds().kinds} keyed={(k) => k.kind.id}>
                  {(k) => (
                    <button
                      type="button"
                      role="tab"
                      data-key={k().kind.id}
                      aria-selected={aria(k().kind.id === kind()?.kind.id)}
                      onClick={() => setKindId(k().kind.id)}
                      {...stylex.attrs(
                        styles.sowFormButton,
                        k().kind.id === kind()?.kind.id ? styles.sowFormButtonSecondary : styles.sowFormButtonPrimary,
                      )}
                    >
                      <SpriteIcon name={k().kind.icon} size={20} />
                      {k().kind.name}
                    </button>
                  )}
                </For>
              </div>
              <Show when={kind()}>
                {(k) => (
                  <div role="tabpanel" aria-label={k().kind.name} {...stylex.attrs(styles.sowFormDiv4)}>
                    <For each={k().templates} keyed={(s) => s.id}>
                      {(s) => <Chip testid="seed" item={s().id} text={s().title} on={text() === s().text} onClick={() => take(s().text, s().blank)} />}
                    </For>
                  </div>
                )}
              </Show>
            </Show>
            <p {...stylex.attrs(styles.sowFormP2)}>{t("web.farm.sow.own")}</p>
            <div {...stylex.attrs(styles.sowFormDiv5)}>
              <PxTextArea
                ref={(el) => (words = el)}
                value={text()}
                selection={selection()}
                onChange={setText}
                rows={3}
                placeholder={t("web.farm.sow.jobHint")}
                label={t("web.farm.sow.job")}
              />
            </div>
            <p {...stylex.attrs(styles.sowFormP3)}>{t("web.farm.sow.who")}</p>
            <div {...stylex.attrs(styles.seedKinds)} role="group" aria-label={t("web.farm.sow.who")}>
              <WhoTile active={sower() === byOrchestrator} label={t("web.farm.sow.orchestratorPicks")} onClick={() => setWho(byOrchestrator)}>
                <span {...stylex.attrs(styles.sowFormSpan2)}>?</span>
              </WhoTile>
              <For each={agents()} keyed={(a) => a.id}>
                {(a) => (
                  <WhoTile active={sower() === a().id} label={a().name} onClick={() => setWho(a().id)}>
                    <AgentFace agentId={a().id} runtime={a().runtime} look={a().look} size={44} />
                  </WhoTile>
                )}
              </For>
            </div>
            <div {...stylex.attrs(styles.sowFormDiv6)}>
              <p {...stylex.attrs(styles.sowFormP4)}>{t("web.farm.sow.how", { repo: p() })}</p>
              <PxButton data-testid="sow-draft" disabled={!canSow()} onClick={() => void write()}>
                {t("web.farm.sow.draft")}
              </PxButton>
              <PxButton tone="primary" data-testid="sow-start" disabled={!canSow()} onClick={sow}>
                {t("web.farm.sow.start")}
              </PxButton>
            </div>
            <Show when={refused()}>
              <p {...stylex.attrs(styles.sowFormP42)}>{refused()}</p>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

const dropsOfAdvice = ([0, 1, 2, 3] as const).map((i) => t(`web.farm.water.drops.${i}`));

export function WaterForm(props: { session: Session; onDone: () => void }) {
  const core = useCore();
  const canTell = () =>
    core()
      ?.issues.find((i) => i.id === issueOf(props.session))
      ?.stage.acts.some((a) => a.act === "tell") ?? false;
  const [text, setText] = createSignal("");
  const sendKey = newSendKey();
  const [refused, setRefused] = createSignal<string>();
  const water = async () => {
    if (!text().trim() || !canTell()) return;
    try {
      await commands.water(props.session, text(), sendKey);
      props.onDone();
    } catch (e) {
      setRefused(reasonOf(e));
    }
  };
  return (
    <div {...stylex.attrs(styles.sowForm)}>
      <p {...stylex.attrs(styles.waterFormP2)}>{props.session.phase._tag === "working" ? t("web.farm.water.working") : t("web.farm.water.idle")}</p>
      <p {...stylex.attrs(styles.waterFormP)}>{t("web.farm.water.thread")}</p>
      <p {...stylex.attrs(styles.waterFormP)}>{t("web.farm.water.job", { brief: props.session.brief })}</p>
      <div {...stylex.attrs(styles.waterFormDiv)}>
        <For each={dropsOfAdvice}>{(s) => <Chip testid="water-advice" text={s} on={text() === s} onClick={() => setText(s)} />}</For>
      </div>
      <div {...stylex.attrs(styles.waterFormDiv2)}>
        <div {...stylex.attrs(styles.waterFormDiv3)}>
          <PxTextArea
            value={text()}
            onChange={setText}
            rows={2}
            placeholder={t("web.farm.water.hint")}
            label={t("web.farm.plot.tell", { who: props.session.name })}
            autoFocus
          />
        </div>
        <PxButton tone="primary" disabled={!text().trim() || !canTell()} onClick={() => void water()}>
          {t("web.farm.water.water")}
        </PxButton>
      </div>
      <Show when={!canTell()}>
        <p {...stylex.attrs(styles.waterFormP22)}>{t("web.farm.water.moved")}</p>
      </Show>
      <Show when={refused()}>
        <p {...stylex.attrs(styles.sowFormP42)}>{refused()}</p>
      </Show>
    </div>
  );
}
