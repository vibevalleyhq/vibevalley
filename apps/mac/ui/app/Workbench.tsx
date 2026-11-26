import { effect, Text, untracked, View, type JSX } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";

import { ToastHost } from "../design/ToastHost";
import { AgentsRoute } from "../features/agent";
import { ArtifactsPage, PresenterPage, StandaloneArtifactPage } from "../features/artifact";
import { ChannelSidePane, ChatPage } from "../features/channel";
import { ContentShell } from "../features/content";
import { Follow } from "../features/inbox";
import { issueSearch } from "../features/issue/model/navigation";
import { IssuesPage } from "../features/issue/views/IssuesPage";
import { LibraryPage } from "../features/media";
import { OrchestratorPage, PendingApprovals } from "../features/orchestrator";
import { ReposPage } from "../features/repo";
import { sortRepos } from "../features/repo/repos";
import { RuntimesPage } from "../features/runtime";
import { RunsPage } from "../features/session";
import { SettingsPage } from "../features/setting";
import { Keyed } from "../infra/base/dom";
import { act } from "../infra/bridge";
import { ready, useRepos } from "../infra/query";
import { Root } from "../infra/Root";
import { Link, Navigate, Outlet, route, type RouteDefinition, type SearchCheck, Routes, useParams } from "../infra/router";
import type { RouterHistory } from "../infra/router/history";
import { safeLastContentPath } from "../infra/state/contentNav";
import { prefsNow } from "../infra/state/prefs";
import { isStorageHydrated } from "../infra/state/storage";
import { defineStored } from "../infra/state/stored";
import { WorkbenchDesignHost } from "./DesignHost";
import { places } from "./places";
import { Shell } from "./Shell";

const farmRoute = route("/farm/:repo", { params: z.object({ repo: z.string().min(1) }) });
const standaloneArtifactRoute = route("/standalone/artifact/:id", { params: z.object({ id: z.string().min(1) }) });

function StandaloneArtifactRoute() {
  const params = useParams(standaloneArtifactRoute);
  return <Keyed key={params().id}>{() => <StandaloneArtifactPage id={untracked(() => params().id)} />}</Keyed>;
}

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

function redirectRoute(from: string, to: string, keepRest = false): RouteDefinition {
  const pattern = route(`${from}/*`);
  return {
    path: pattern,
    component: () => {
      const params = useParams(pattern);
      const target = () => {
        const rest = params().rest;
        return keepRest && rest ? `${to}/${rest}` : to;
      };
      return <Navigate href={target()} />;
    },
  };
}

/** The repo whose farm was open last (VibeValley's farm/store.ts lastFarm). */
const lastFarm = defineStored("farm.repo", z.string().nullable(), null);

/** The farm is the app's own GPU-painted diorama view: this page asks the shell for it (`openFarm`). */
function Farm(props: { repo: string }) {
  effect(() => {
    if (props.repo) lastFarm.set(props.repo);
    act({ type: "openFarm", repo: props.repo });
  });
  return (
    <View testID="farm" class="flex-1 items-center justify-center bg-page p-6">
      <Text class="text-sm text-muted">{t("web.base.farm")}</Text>
    </View>
  );
}

/** VibeValley's FarmHome: the farm last open, else the repo worked in most recently, else the farm with none. */
function FarmHome() {
  const repos = useRepos();
  const list = () => ready(repos, undefined);
  const enter = (name: string) => <Navigate href={farmRoute.build({ repo: name })} />;
  const known = () => {
    const last = lastFarm.get() ?? undefined;
    return last !== undefined && (list()?.some((p) => p.name === last) ?? true) ? last : undefined;
  };
  return (
    <If when={isStorageHydrated()}>
      <If
        when={known()}
        else={
          <If
            when={list()?.length === 0 || repos.status() === "error"}
            else={<If when={list()}>{(all) => enter(untracked(() => sortRepos(all())[0]?.name ?? ""))}</If>}
          >
            <Farm repo="" />
          </If>
        }
      >
        {(name) => enter(name())}
      </If>
    </If>
  );
}

function RepoFarm() {
  const params = useParams(farmRoute);
  return <Keyed key={params().repo}>{() => <Farm repo={untracked(() => params().repo)} />}</Keyed>;
}

function MissingPage(props: { invalid?: boolean }) {
  return (
    <View testID="route-missing" class="flex-1 items-center justify-center gap-4 bg-page p-6">
      <Text role="header" class="text-lg font-semibold text-ink">
        {props.invalid === true ? t("web.base.route.invalid") : t("web.base.route.missing")}
      </Text>
      <Link href="/">
        <Text class="text-accent underline">{t("web.base.route.home")}</Text>
      </Link>
    </View>
  );
}

const routes: readonly RouteDefinition[] = [
  {
    path: "/",
    component: () => (
      <If when={isStorageHydrated()}>
        <Navigate href={prefsNow().start === "farm" ? "/farm" : (places[0]?.path ?? "/issues")} />
      </If>
    ),
  },

  { path: "/present", component: PresenterPage },
  { path: standaloneArtifactRoute, component: StandaloneArtifactRoute },
  {
    layout: () => (
      <Shell>
        <Outlet />
      </Shell>
    ),
    children: [
      redirectRoute("/tree", "/settings/memory"),
      { path: "/farm", meta: { skin: "farm" }, component: FarmHome },
      { path: "/farm/", meta: { skin: "farm" }, component: () => <Farm repo="" /> },
      { path: farmRoute, meta: { skin: "farm" }, component: RepoFarm },
      { path: "/workspace", meta: { place: "workspace" }, component: () => <View testID="native-workspace" class="flex-1" /> },
      page("/issues", "issues", (rest) => <IssuesPage rest={rest()} />, issueSearch),
      page("/runs", "runs", () => <RunsPage approvals={PendingApprovals} />),
      page("/chat", "chat", () => <ChatPage />),
      page("/settings", "settings", (rest) => <SettingsPage rest={rest()} />),
      { path: "/team", component: () => <Navigate href="/agents" /> },
      redirectRoute("/team/skills", "/settings/skills", true),
      redirectRoute("/skills", "/settings/skills", true),
      redirectRoute("/team/memory", "/settings/memory"),
      redirectRoute("/memory", "/settings/memory"),
      page("/orchestrator", "team", (rest) => <OrchestratorPage rest={rest()} />),
      page("/agents", "team", (rest) => <AgentsRoute rest={rest()} />),
      page("/runtimes", "runtimes", (rest) => <RuntimesPage rest={rest()} />),
      page("/repos", "workspace", (rest) => <ReposPage rest={rest()} />),
      {
        path: "/content",
        component: () => (
          <If when={isStorageHydrated()}>
            <Navigate href={safeLastContentPath()} />
          </If>
        ),
      },
      {
        layout: () => (
          <ContentShell>
            <Outlet />
          </ContentShell>
        ),
        children: [
          page("/library", "content", () => <LibraryPage />),
          page("/artifacts", "content", (rest) => <ArtifactsPage rest={rest()} chat={ChannelSidePane} />),
        ],
      },
    ],
  },
];

export function App(props: { history?: RouterHistory }) {
  return (
    <Root history={props.history}>
      <WorkbenchDesignHost>
        <Follow />
        <View testID="workbench-page" class="flex-1 bg-page">
          <Routes routes={routes} fallback={() => <MissingPage />} invalid={() => <MissingPage invalid />} />
          <ToastHost />
        </View>
      </WorkbenchDesignHost>
    </Root>
  );
}
