import type { JSX } from "@solidjs/web";
import { Match, Switch, untrack } from "solid-js";
import { z } from "zod";

import { t } from "@vibevalley/i18n";

import { Keyed } from "#/base/dom.tsx";
import { FarmPage } from "#/farm/FarmPage.tsx";
import { repoMap } from "#/farm/map/RepoMap.tsx";
import { lastFarmRepo } from "#/farm/store.ts";
import { AgentsRoute } from "#/features/agent/index.ts";
import { ArtifactsPage, PresenterPage } from "#/features/artifact/index.ts";
import { CatalogPage } from "#/features/catalog/index.ts";
import { ChatPage, chatSay } from "#/features/channel/index.ts";
import { Follow } from "#/features/inbox/index.ts";
import { IssuesPage, issueSearch } from "#/features/issue/index.ts";
import { PairPage } from "#/features/lan/index.ts";
import { LibraryPage } from "#/features/media/index.ts";
import { OrchestratorPage } from "#/features/orchestrator/index.ts";
import { PkmPage } from "#/features/pkm/index.ts";
import { ReposPage, sortRepos } from "#/features/repo/index.ts";
import { RuntimesPage } from "#/features/runtime/index.ts";
import { SettingsPage } from "#/features/setting/index.ts";
import { ApprovePage, LoginPage } from "#/features/user/index.ts";
import { ready, useRepos } from "#/infra/query.ts";
import { Link, Navigate, Outlet, route, type RouteDefinition, type SearchCheck, Routes, useParams } from "#/infra/router.ts";
import { prefsNow } from "#/state/prefs.ts";
import { TreePage } from "#/tree/TreePage.tsx";
import { WindowStrip } from "#/ui/layout.tsx";
import { ToastHost } from "#/ui/ToastHost.tsx";

import { places } from "./places";
import { Root } from "./Root";
import { Shell } from "./Shell";

const farmRoute = route("/farm/:repo", { params: z.object({ repo: z.string().min(1) }) });

function page(path: string, place: string, render: (rest: () => string) => JSX.Element, search?: SearchCheck): RouteDefinition {
  const pattern = route(`${path}/*`, search ? { search } : undefined);
  return {
    path: pattern,
    meta: { place },
    component: () => {
      const params = useParams(pattern);
      return render(() => params().rest);
    },
  };
}

function FarmHome() {
  const repos = useRepos();
  const last = untrack(lastFarmRepo);
  const list = () => ready(repos, undefined);
  const enter = (name: string) => <Navigate href={farmRoute.build({ repo: name })} />;
  return (
    <Switch>
      <Match when={last !== undefined && (list()?.some((p) => p.name === last) ?? true) ? last : undefined}>{(name) => enter(name())}</Match>
      <Match when={list()?.length === 0 || repos.status() === "error"}>
        <FarmPage repo="" />
      </Match>
      <Match when={list()}>{(all) => enter(untrack(() => sortRepos(all())[0]?.name ?? ""))}</Match>
    </Switch>
  );
}

function RepoFarm() {
  const params = useParams(farmRoute);
  return <Keyed key={params().repo}>{() => <FarmPage repo={untrack(() => params().repo)} />}</Keyed>;
}

function MissingPage(props: { invalid?: boolean }) {
  return (
    <main data-testid="route-missing" class="grid h-full place-content-center gap-4 bg-page p-6 text-ink">
      <h1 class="text-lg font-semibold">{props.invalid === true ? t("web.base.route.invalid") : t("web.base.route.missing")}</h1>
      <Link href="/" class="text-accent underline">
        {t("web.base.route.home")}
      </Link>
    </main>
  );
}

const routes: readonly RouteDefinition[] = [
  { path: "/", component: () => <Navigate href={prefsNow().start === "farm" ? "/farm" : (places[0]?.path ?? "/issues")} /> },
  {
    layout: () => (
      <Shell>
        <Outlet />
      </Shell>
    ),
    children: [
      { path: "/farm", meta: { skin: "farm" }, component: FarmHome },
      { path: "/farm/", meta: { skin: "farm" }, component: () => <FarmPage repo="" /> },
      { path: farmRoute, meta: { skin: "farm" }, component: RepoFarm },
      page("/issues", "issues", (rest) => <IssuesPage rest={rest()} />, issueSearch),
      page("/chat", "chat", () => (
        <div class="h-full">
          <ChatPage />
        </div>
      )),
      page("/settings", "settings", (rest) => <SettingsPage rest={rest()} />),
      page("/approve", "settings", () => <ApprovePage />),
      page("/orchestrator", "agents", (rest) => <OrchestratorPage rest={rest()} />),
      page("/agents", "agents", (rest) => <AgentsRoute rest={rest()} />),
      page("/runtimes", "runtimes", (rest) => <RuntimesPage rest={rest()} />),
      page("/repos", "repos", (rest) => <ReposPage rest={rest()} skin={repoMap} />),
      page("/catalog", "catalog", (rest) => <CatalogPage rest={rest()} />),
      page("/library", "library", () => <LibraryPage />),
      page("/artifacts", "artifacts", (rest) => <ArtifactsPage rest={rest()} say={chatSay} />),
      page("/pkm", "pkm", (rest) => <PkmPage rest={rest()} />),
    ],
  },
  { path: "/tree", component: TreePage },
  { path: "/pair", component: PairPage },
  // A deck's speaker's window: a page of its own, opened from the slides' controls.
  { path: "/present", component: PresenterPage },
  { path: "/login", component: LoginPage },
];

export function App() {
  return (
    <Root>
      <WindowStrip />
      <Follow />
      <Routes routes={routes} fallback={() => <MissingPage />} invalid={() => <MissingPage invalid />} />
      <ToastHost />
    </Root>
  );
}
