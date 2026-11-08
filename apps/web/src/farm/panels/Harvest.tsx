import * as stylex from "@stylexjs/stylex";
import { For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Changes, Issue, Session } from "@vibevalley/protocol";
import { assignedAgentOf } from "@vibevalley/protocol/rules";

import { useNow } from "#/base/dom.tsx";
import { ago } from "#/base/format.ts";
import { commands } from "#/farm/frames.ts";
import { harvestedOf } from "#/farm/hud/readout.ts";
import { issueOf } from "#/farm/world/plots.ts";
import { changeKind, lineCounts, nothingChanged, issueTitle, useIssueChanges } from "#/features/issue/index.ts";
import { reasonOf } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { ready, useAgents } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { createPixelAct, FarmSection, PxButton, SpriteIcon } from "#/ui/pixel/index.ts";

import { FarmEmpty, FarmTag, FileRow, PlusMinus, tint, Tinted } from "./rows";

const recipeStyles2 = stylex.create({
  readyViewTinted: {
    marginTop: "calc(var(--spacing) * 3)",
  },
  readyViewTinted2: {
    marginTop: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2.5)",
  },
});

const recipeStyles = stylex.create({
  readyViewSpan: {
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  readyViewP: {
    marginTop: "calc(var(--spacing) * 1.5)",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  readyViewP2: {
    marginTop: "calc(var(--spacing) * 2)",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  warehouseSpan: {
    marginTop: "var(--spacing)",
    display: "block",
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
});

const variantStyles = stylex.create({
  warehouseSpan: {
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "13px",
  },
});

const viewStyles = stylex.create({
  harvestReviewDiv: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 3)",
  },
  harvestReviewP: {
    fontSize: "13px",
    color: "var(--color-berry)",
  },
  harvestReviewP2: {
    paddingBlock: "calc(var(--spacing) * 10)",
    textAlign: "center",
    fontSize: "13px",
    color: "var(--color-bark-600)",
  },
  readyViewDiv: {
    display: "flex",
    flexDirection: "column",
  },
  readyViewDiv2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  readyViewP: {
    fontSize: "13px",
    color: "var(--color-bark-600)",
  },
  readyViewDiv3: {
    marginTop: "calc(var(--spacing) * 1.5)",
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--spacing)",
  },
  readyViewP2: {
    fontSize: "12px",
    color: "var(--color-bark-800)",
  },
  readyViewDiv4: {
    marginTop: "var(--spacing)",
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--spacing)",
  },
  readyViewSpan: {
    backgroundColor: "var(--color-cream-50)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
  },
  readyViewDiv5: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
  readyViewDiv6: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingBlock: "1px",
  },
  readyViewSpan2: {
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    color: "var(--color-bark-500)",
  },
  readyViewSpan3: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "13px",
  },
  readyViewSpan4: {
    fontSize: "12px",
    color: "var(--color-bark-400)",
  },
  readyViewDiv7: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  warehouseDiv: {
    display: "grid",
    gap: "calc(var(--spacing) * 2)",
    gridTemplateColumns: {
      default: null,
      "@media (width>=40rem)": "repeat(2,minmax(0,1fr))",
    },
  },
  warehouseButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 3)",
    backgroundColor: {
      default: "var(--color-cream-100)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-200)",
      },
    },
    padding: "calc(var(--spacing) * 3)",
    textAlign: "left",
  },
  warehouseSpan: {
    minWidth: "0",
    flex: "1",
  },
});

export function HarvestReview(props: { session: Session; onDone: () => void }) {
  const changes = useIssueChanges(() => issueOf(props.session));
  return (
    <Switch>
      <Match when={changes.status() === "success" ? changes.data() : undefined}>
        {(data) => <ReadyView session={props.session} changes={data()} onDone={() => props.onDone()} />}
      </Match>
      <Match when={changes.error()}>
        {(error) => (
          <div {...stylex.attrs(viewStyles.harvestReviewDiv)}>
            <Tinted color={tint("#c84a3a", 0.12)}>
              <p {...stylex.attrs(viewStyles.harvestReviewP)}>
                {t("web.farm.graph.unreadable")}
                {reasonOf(error())}
              </p>
            </Tinted>
            <PxButton onClick={() => props.onDone()}>{t("web.farm.notNow")}</PxButton>
          </div>
        )}
      </Match>
      <Match when={true}>
        <p {...stylex.attrs(viewStyles.harvestReviewP2)}>{t("web.farm.harvest.reading")}</p>
      </Match>
    </Switch>
  );
}

function ReadyView(props: { session: Session; changes: Changes; onDone: () => void }) {
  const now = useNow();
  const core = useCore();
  const acts = () => (core()?.issues.find((i) => i.id === issueOf(props.session))?.stage.acts ?? []).map((a) => a.act);
  const counts = () => lineCounts(props.changes);
  const empty = () => nothingChanged(props.changes);
  const conflicts = () => props.changes.conflicts;
  const act = createPixelAct(t("web.farm.plot.failed"));
  // The window stays until the server took it, so a refusal is said beside it and the press can be made again.
  const take = async () => {
    if (!acts().includes("complete")) return;
    const session = props.session;
    if ((await act.run(async () => (await commands.harvest(session), true))) === true) props.onDone();
  };
  const resolve = async () => {
    if (!acts().includes("resolve")) return;
    const session = props.session;
    if ((await act.run(async () => (await commands.resolve(session), true))) === true) props.onDone();
  };
  return (
    <div {...stylex.attrs(viewStyles.readyViewDiv)}>
      <div {...stylex.attrs(viewStyles.readyViewDiv2)}>
        <FarmTag text={t("web.farm.harvest.repo", { repo: props.changes.repo })} fill="#a5743f" ink="#f7e8c4" />
        <Show when={props.changes.branch}>
          <FarmTag text={`${props.changes.branch} → ${props.changes.base}`} ink="#46301d" />
        </Show>
        <span {...stylex.attrs(recipeStyles.readyViewSpan)}>
          {t("web.farm.harvest.counts", { commits: props.changes.commits.length, files: props.changes.files.length })}
        </span>
        <Show when={props.changes.files.length > 0}>
          <PlusMinus added={counts()[0]} removed={counts()[1]} />
        </Show>
      </div>
      <Show
        when={conflicts().length > 0}
        fallback={
          <Show when={empty()}>
            <Tinted styles={[recipeStyles2.readyViewTinted]}>
              <p {...stylex.attrs(viewStyles.readyViewP)}>{t("web.farm.harvest.none")}</p>
            </Tinted>
          </Show>
        }
      >
        <Tinted color={tint("#c84a3a", 0.12)} styles={[recipeStyles2.readyViewTinted2]}>
          <p {...stylex.attrs(viewStyles.harvestReviewP)}>{t("web.farm.harvest.conflict", { base: props.changes.base })}</p>
          <div {...stylex.attrs(viewStyles.readyViewDiv3)}>
            <For each={conflicts()}>{(f) => <FarmTag text={f} fill="#f7e8c4" ink="#c84a3a" />}</For>
          </div>
          <p {...stylex.attrs(recipeStyles.readyViewP)}>{t("web.farm.harvest.resolveHow", { base: props.changes.base })}</p>
        </Tinted>
      </Show>
      <Show when={props.changes.behind > 0 && conflicts().length === 0}>
        <p {...stylex.attrs(recipeStyles.readyViewP2)}>{t("web.farm.harvest.behind", { base: props.changes.base, n: Math.round(props.changes.behind) })}</p>
      </Show>
      <Show when={props.changes.uncommitted.length > 0}>
        <Tinted color={tint("#e5a93c", 0.2)} styles={[recipeStyles2.readyViewTinted]}>
          <p {...stylex.attrs(viewStyles.readyViewP2)}>{t("web.farm.harvest.uncommitted", { n: props.changes.uncommitted.length })}</p>
          <div {...stylex.attrs(viewStyles.readyViewDiv4)}>
            <For each={props.changes.uncommitted}>
              {(f) => (
                <span {...stylex.attrs(viewStyles.readyViewSpan)}>
                  {changeKind(f.status).mark} {f.path}
                </span>
              )}
            </For>
          </div>
        </Tinted>
      </Show>
      <div {...stylex.attrs(viewStyles.readyViewDiv5)}>
        <Show when={acts().includes("complete")}>
          <PxButton tone="primary" data-act="complete" disabled={act.busy()} onClick={() => void take()}>
            {empty() ? t("web.farm.harvest.letGo") : t("web.farm.harvest.take", { base: props.changes.base })}
          </PxButton>
        </Show>
        <Show when={acts().includes("resolve")}>
          <PxButton tone="danger" data-act="resolve" disabled={act.busy()} onClick={() => void resolve()}>
            {t("web.farm.harvest.resolve")}
          </PxButton>
        </Show>
        <PxButton onClick={() => props.onDone()}>{t("web.farm.notNow")}</PxButton>
      </div>
      <Show when={!acts().includes("complete") && !acts().includes("resolve")}>
        <p {...stylex.attrs(recipeStyles.readyViewP2)}>{t("web.farm.water.moved")}</p>
      </Show>
      <Show when={props.changes.commits.length > 0}>
        <FarmSection title={t("web.farm.graph.commits")}>
          <For each={props.changes.commits}>
            {(c) => (
              <div {...stylex.attrs(viewStyles.readyViewDiv6)}>
                <span {...stylex.attrs(viewStyles.readyViewSpan2)}>{c.hash}</span>
                <span {...stylex.attrs(viewStyles.readyViewSpan3)}>{c.subject}</span>
                <span {...stylex.attrs(viewStyles.readyViewSpan4)}>{ago(c.at, now())}</span>
              </div>
            )}
          </For>
        </FarmSection>
      </Show>
      <Show when={props.changes.files.length > 0}>
        <FarmSection title={t("web.farm.harvest.files")}>
          <div {...stylex.attrs(viewStyles.readyViewDiv7)}>
            <For each={props.changes.files}>{(f) => <FileRow file={f} conflict={conflicts().includes(f.path)} />}</For>
          </div>
        </FarmSection>
      </Show>
    </div>
  );
}

export function Warehouse() {
  const core = useCore();
  const agentsQuery = useAgents();
  const router = useRouter();
  const now = useNow();
  const agents = () => new Map(ready(agentsQuery, []).map((a) => [a.id, a]));
  const agentName = (issue: Issue) => {
    const id = assignedAgentOf(issue);
    return id ? (agents().get(id)?.name ?? id) : undefined;
  };
  const stored = () => harvestedOf(core());
  const issues = () => core()?.issues ?? [];
  return (
    <Show when={stored().length > 0} fallback={<FarmEmpty text={t("web.farm.harvest.empty")} />}>
      <div {...stylex.attrs(viewStyles.warehouseDiv)}>
        <For each={stored()}>
          {(i) => (
            <button
              type="button"
              aria-label={issueTitle(i, issues())}
              onClick={() => {
                router.navigate(`/issues/${encodeURIComponent(i.id)}`);
              }}
              {...stylex.attrs(viewStyles.warehouseButton)}
            >
              <SpriteIcon name="icon-harvest" size={40} />
              <span {...stylex.attrs(viewStyles.warehouseSpan)}>
                <span {...stylex.attrs(variantStyles.warehouseSpan)}>{issueTitle(i, issues())}</span>
                <span {...stylex.attrs(recipeStyles.warehouseSpan)}>
                  {[agentName(i), i.repo, i.closedAt !== undefined ? t("web.farm.harvest.taken", { ago: ago(i.closedAt, now()) }) : undefined]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
