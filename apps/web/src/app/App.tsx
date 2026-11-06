import type { JSX } from "@solidjs/web";
import { Match, Show, Switch, untrack } from "solid-js";

import { Keyed } from "#/base/dom.tsx";
import { FarmPage } from "#/farm/FarmPage.tsx";
import { repoMap } from "#/farm/map/RepoMap.tsx";
import { lastFarmRepo } from "#/farm/store.ts";
import { AgentsRoute } from "#/features/agent/index.ts";
import { ArtifactsPage } from "#/features/artifact/index.ts";
import { CatalogPage } from "#/features/catalog/index.ts";
import { ChatPage, chatSay } from "#/features/channel/index.ts";
import { Follow } from "#/features/inbox/index.ts";
import { IssuesPage } from "#/features/issue/index.ts";
import { PairPage } from "#/features/lan/index.ts";
import { OrchestratorPage } from "#/features/orchestrator/index.ts";
import { PkmPage } from "#/features/pkm/index.ts";
import { ReposPage, sortRepos } from "#/features/repo/index.ts";
import { RuntimesPage } from "#/features/runtime/index.ts";
import { SettingsPage } from "#/features/setting/index.ts";
import { ready, useRepos } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { prefsNow } from "#/state/prefs.ts";
import { TreePage } from "#/tree/TreePage.tsx";
import { Navigate } from "#/ui/A.tsx";
import { WindowStrip } from "#/ui/layout.tsx";
import { ToastHost } from "#/ui/ToastHost.tsx";

import { places as placeList } from "./places";
import { Root } from "./Root";
import { Shell } from "./Shell";

type Rest = () => string;

const places: Record<string, (rest: Rest) => JSX.Element> = {
  issues: (rest) => <IssuesPage rest={rest()} />,
  chat: () => (
    <div class="h-full">
      <ChatPage />
    </div>
  ),
  settings: (rest) => <SettingsPage rest={rest()} />,
  orchestrator: (rest) => <OrchestratorPage rest={rest()} />,
  agents: (rest) => <AgentsRoute rest={rest()} />,
  runtimes: (rest) => <RuntimesPage rest={rest()} />,
  repos: (rest) => <ReposPage rest={rest()} skin={repoMap} />,
  catalog: (rest) => <CatalogPage rest={rest()} />,
  artifacts: (rest) => <ArtifactsPage rest={rest()} say={chatSay} />,
  pkm: (rest) => <PkmPage rest={rest()} />,
};

/** The farm entered last on this machine, trusted while the repos are still loading. */
function FarmHome() {
  const repos = useRepos();
  const last = lastFarmRepo();
  const list = () => ready(repos, undefined);
  const enter = (name: string) => <Navigate href={`/farm/${encodeURIComponent(name)}`} />;
  return (
    <Switch>
      <Match when={last !== undefined && (list()?.some((p) => p.name === last) ?? true) ? last : undefined}>{(name) => enter(name())}</Match>
      <Match when={list()?.length === 0 || repos.isError}>
        <FarmPage repo="" />
      </Match>
      {/* Entered once, by the list as it is now. */}
      <Match when={list()}>{(all) => enter(untrack(() => sortRepos(all())[0]?.name ?? ""))}</Match>
    </Switch>
  );
}

function Routes() {
  const router = useRouter();
  const pathname = () => router.path().split("?")[0] ?? "/";
  const place = () => pathname().split("/")[1] ?? "";
  const rest = () => pathname().split("/").slice(2).join("/");
  return (
    <Switch fallback={<Navigate href="/" />}>
      {/* Where this machine opens (Settings > General): the workbench unless the owner chose the farm. */}
      <Match when={pathname() === "/"}>
        <Navigate href={prefsNow().start === "farm" ? "/farm" : (placeList[0]?.path ?? "/issues")} />
      </Match>
      {/* Before the farms by repo: /farm/ (empty) is the farm of the sessions without one. */}
      <Match when={pathname() === "/farm"}>
        <FarmHome />
      </Match>
      <Match when={place() === "farm"}>
        {/* One farm per repo: entering another builds its farm anew. */}
        <Keyed key={decodeURIComponent(rest())}>{() => <FarmPage repo={untrack(() => decodeURIComponent(rest()))} />}</Keyed>
      </Match>
      <Match when={pathname() === "/tree"}>
        <TreePage />
      </Match>
      <Match when={pathname() === "/pair"}>
        <PairPage />
      </Match>
      <Match when={place() in places}>
        <Shell>
          {/* One place at a time: moving within a place keeps its page, moving to another builds that one. */}
          <Show when={places[place()]} keyed>
            {(render) => render(rest)}
          </Show>
        </Shell>
      </Match>
    </Switch>
  );
}

export function App() {
  return (
    <Root>
      <WindowStrip />
      <Follow />
      <Routes />
      <ToastHost />
    </Root>
  );
}
