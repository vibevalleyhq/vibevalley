import * as stylex from "@stylexjs/stylex";
import { For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Agent, RuntimeInfo } from "@vibevalley/protocol";

import { Keyed, variant } from "#/base/dom.tsx";
import { wallClockText } from "#/base/format.ts";
import { useWorkAgents } from "#/infra/agents.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { runtimesQuery, useQueryClient, ready, useRuntimes } from "#/infra/query.ts";
import { Link as A } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { AgentFace } from "#/ui/Face.tsx";
import { Card, ListCard, ListRow, Quiet, Split } from "#/ui/layout.tsx";
import { RuntimeIcon } from "#/ui/pixel/RuntimeIcon.tsx";
import { styleProps } from "#/ui/positioner.ts";

import { quotaOf } from "./quota";
import { InventoryCard, ModelsCard, SettingsCard, Stamina, SupportCard, Usage } from "./RuntimeCards";

const recipeStyles = stylex.create({
  runtimesPageSpan: {
    width: "calc(var(--spacing) * 2)",
    height: "calc(var(--spacing) * 2)",
    borderRadius: "2147483647px",
  },
  runtimesPageSpanState: {
    backgroundColor: "var(--wb-berry)",
  },
  runtimesPageSpanState2: {
    backgroundColor: "var(--wb-faint)",
  },
  runtimesPageSpanState3: {
    backgroundColor: "var(--wb-leaf)",
  },
});

const variantStyles2 = stylex.create({
  detailA: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    textDecorationLine: "underline",
  },
  detailA2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    paddingBlock: "var(--spacing)",
    paddingRight: "calc(var(--spacing) * 3)",
    paddingLeft: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
});

const variantStyles = stylex.create({
  runtimesPageSpan: {},
  runtimesPageSpanVariant: {
    opacity: ".5",
    filter: "grayscale(100%)",
  },
  detailDiv: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
});

const viewStyles = stylex.create({
  portrait: (hat: string) => ({ backgroundImage: `radial-gradient(70% 70% at 50% 70%, ${hat}33, var(--color-page))` }),
  runtimesPageP: {
    padding: "calc(var(--spacing) * 8)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-berry)",
  },
  runtimesPageDiv: {
    height: "100%",
  },
  runtimesPageLi: {
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingTop: "var(--spacing)",
    paddingBottom: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  runtimesPageSpan: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "var(--spacing)",
  },
  detailDiv: {
    display: "flex",
    maxWidth: "var(--container-4xl)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  detailDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 4)",
    paddingInline: "var(--spacing)",
    paddingTop: "var(--spacing)",
    paddingBottom: "calc(var(--spacing) * 2)",
  },
  detailSpan: {
    display: "flex",
    width: "calc(var(--spacing) * 18)",
    height: "calc(var(--spacing) * 18)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
  },
  detailH2: {
    fontSize: "var(--text-xl)",
    lineHeight: "var(--text-xl--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  detailP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  detailDiv3: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingTop: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  detailSpan2: {
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-ok-soft)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    color: "var(--color-ok-ink)",
  },
  detailSpan3: {
    fontFamily: "var(--font-mono)",
  },
  detailSpan4: {
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-bad-soft)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    color: "var(--color-berry)",
  },
  detailDiv4: {
    display: "grid",
    gap: "calc(var(--spacing) * 3)",
    gridTemplateColumns: {
      default: null,
      "@media (width>=48rem)": "repeat(2,minmax(0,1fr))",
    },
  },
  detailDiv5: {
    display: "grid",
    gap: "calc(var(--spacing) * 3)",
    gridTemplateColumns: {
      default: null,
      "@media (width>=48rem)": "repeat(3,minmax(0,1fr))",
    },
  },
  detailDiv6: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
});

const statusOf = (r: RuntimeInfo) => {
  const i = r.installation;
  switch (i.status) {
    case "available":
      return r.settings.enabled ? (i.version ?? t("web.runtime.available")) : t("web.runtime.disabled");
    // The reason, not just unsupported: for vibevalley it is a missing DeepSeek key, which is the user's to fix.
    case "unsupported":
      return i.reason || t("web.runtime.unsupported");
    case "not_found":
      return t("web.runtime.notFound");
    case "checking":
      return t("web.runtime.checking");
  }
};

/** `rest` is the path after /runtimes/. */
export function RuntimesPage(props: { rest: string }) {
  const runtimes = useRuntimes();
  const agents = useWorkAgents();
  const list = () => ready(runtimes, []);
  const selected = () => list().find((r) => r.id === props.rest) ?? list()[0];
  return (
    <Show
      when={!runtimes.error()}
      fallback={
        <p {...stylex.attrs(viewStyles.runtimesPageP)}>
          {t("web.runtime.noRuntimes")}
          {reasonOf(runtimes.error())}
        </p>
      }
    >
      <div {...stylex.attrs(viewStyles.runtimesPageDiv)}>
        <Split
          edge
          list={
            <ListCard bare title={t("web.runtime.title")} label={t("web.runtime.list")} testid="runtimes">
              <li {...stylex.attrs(viewStyles.runtimesPageLi)}>{t("web.runtime.intro")}</li>
              <For each={list()}>
                {(r) => {
                  const ok = () => r.installation.status === "available";
                  const using = () => agents().filter((a) => a.runtime === r.id).length;
                  const quota = () => quotaOf(r);
                  return (
                    <ListRow
                      to={`/runtimes/${r.id}`}
                      item={r.id}
                      active={selected()?.id === r.id}
                      title={r.preset.label}
                      line={`${statusOf(r)}${using() > 0 ? t("web.runtime.usedBy", { n: using() }) : ""}`}
                      leading={
                        <span {...stylex.attrs(variantStyles.runtimesPageSpan, !ok() ? variantStyles.runtimesPageSpanVariant : variantStyles.runtimesPageSpan)}>
                          <RuntimeIcon runtime={r.id} size={36} />
                        </span>
                      }
                      trailing={
                        <span {...stylex.attrs(viewStyles.runtimesPageSpan)}>
                          <span
                            {...stylex.attrs(
                              recipeStyles.runtimesPageSpan,
                              ok()
                                ? r.settings.enabled
                                  ? recipeStyles.runtimesPageSpanState3
                                  : recipeStyles.runtimesPageSpanState2
                                : recipeStyles.runtimesPageSpanState,
                            )}
                            aria-hidden="true"
                          />
                          <Show when={ok() && quota().level !== "unknown"}>
                            <Stamina quota={quota()} width={60} height={7} />
                          </Show>
                        </span>
                      }
                    />
                  );
                }}
              </For>
            </ListCard>
          }
        >
          <Show when={selected()} fallback={<Quiet>{t("web.runtime.reading")}</Quiet>}>
            {(s) => <Keyed key={s().id}>{() => <Detail info={s()} agents={agents().filter((a) => a.runtime === s().id)} />}</Keyed>}
          </Show>
        </Split>
      </div>
    </Show>
  );
}

export function Detail(props: { info: RuntimeInfo; agents: Agent[] }) {
  const client = useQueryClient();
  const refreshing = createAct();
  const inst = () => props.info.installation;
  const keep = (got: RuntimeInfo) => client.setData(runtimesQuery(), (all) => (all ? { value: all.value.map((r) => (r.id === got.id ? got : r)) } : undefined));
  const refresh = () => {
    const id = props.info.id;
    return refreshing.run(async () => keep(await api.runtime.refresh({ id })));
  };
  return (
    <div {...stylex.attrs(viewStyles.detailDiv)}>
      <div {...stylex.attrs(viewStyles.detailDiv2)}>
        <span {...styleProps([viewStyles.detailSpan, viewStyles.portrait(props.info.preset.look.hat)])}>
          <span
            {...stylex.attrs(
              variantStyles.runtimesPageSpan,
              inst().status !== "available" ? variantStyles.runtimesPageSpanVariant : variantStyles.runtimesPageSpan,
            )}
          >
            <RuntimeIcon runtime={props.info.id} size={60} />
          </span>
        </span>
        <div {...stylex.attrs(variantStyles.detailDiv)}>
          <h2 {...stylex.attrs(viewStyles.detailH2)}>{props.info.preset.label}</h2>
          <p {...stylex.attrs(viewStyles.detailP)}>{props.info.preset.blurb}</p>
          <div {...stylex.attrs(viewStyles.detailDiv3)}>
            <Switch>
              <Match when={variant(inst(), "status", "available")}>
                {(i) => (
                  <>
                    <span {...stylex.attrs(viewStyles.detailSpan2)}>
                      {t("web.runtime.available")} {i().version ?? ""}
                    </span>
                    <span {...stylex.attrs(viewStyles.detailSpan3)}>{i().command}</span>
                    <span>{i().via === "bundled" ? t("web.runtime.bundled") : t("web.runtime.commandLine")}</span>
                  </>
                )}
              </Match>
              <Match when={variant(inst(), "status", "unsupported")}>
                {(i) => <span {...stylex.attrs(viewStyles.detailSpan4)}>{t("web.runtime.unsupportedWhy", { why: i().reason })}</span>}
              </Match>
              <Match when={inst().status === "not_found"}>
                <span {...stylex.attrs(viewStyles.detailSpan4)}>{t("web.runtime.notHere")}</span>
              </Match>
            </Switch>
            <Show when={inst().status !== "checking"} fallback={<span>{t("web.runtime.checking")}</span>}>
              <span>{t("web.runtime.checkedAt", { clock: wallClockText(props.info.checkedAt) })}</span>
            </Show>
          </div>
        </div>
        <Button disabled={refreshing.busy()} onClick={() => void refresh()}>
          {refreshing.busy() ? t("web.runtime.checking") : t("web.runtime.recheck")}
        </Button>
      </div>
      <div {...stylex.attrs(viewStyles.detailDiv4)}>
        <Card title={t("web.runtime.account")}>
          <Usage info={props.info} />
        </Card>
        <SupportCard info={props.info} />
      </div>
      <SettingsCard info={props.info} onSaved={keep} />
      <ModelsCard info={props.info} />
      <div {...stylex.attrs(viewStyles.detailDiv5)}>
        <InventoryCard title={t("web.runtime.skills")} entries={props.info.skills} />
        <InventoryCard title={t("web.runtime.mcp")} entries={props.info.mcpServers} />
        <InventoryCard title={t("web.runtime.tools")} entries={props.info.tools} />
      </div>
      <Card
        title={t("web.runtime.agents")}
        action={
          <A href={`/agents/new?runtime=${encodeURIComponent(props.info.id)}`} data-testid="new-agent" {...stylex.attrs(variantStyles2.detailA)}>
            {t("web.runtime.makeAgent")}
          </A>
        }
      >
        <Show when={props.agents.length > 0} fallback={<Quiet>{t("web.runtime.noneYet")}</Quiet>}>
          <div {...stylex.attrs(viewStyles.detailDiv6)}>
            <For each={props.agents}>
              {(a) => (
                <A href={`/agents/${encodeURIComponent(a.id)}`} {...stylex.attrs(variantStyles2.detailA2)}>
                  <AgentFace agentId={a.id} runtime={a.runtime} look={a.look} size={26} />
                  {a.name}
                </A>
              )}
            </For>
          </div>
        </Show>
      </Card>
    </div>
  );
}
