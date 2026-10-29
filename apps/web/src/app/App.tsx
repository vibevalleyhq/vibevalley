// The page's routes. The farm is full-bleed, outside the workbench's shell; the shell links back to it. Each workbench
// place gets the rest of the path after its own (/issues/<id> → "<id>").

import { Match, Show, Switch, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ChatPage } from "@/features/channel";
import { FarmPage } from "@/farm/FarmPage";
import { TreePage } from "@/tree/TreePage";
import { AgentsRoute } from "@/features/agent";
import { CatalogPage } from "@/features/catalog";
import { ArtifactsPage } from "@/features/artifact";
import { IssuesPage } from "@/features/issue";
import { OrchestratorPage } from "@/features/orchestrator";
import { PairPage } from "@/features/lan";
import { ProjectsPage, sortProjects } from "@/features/project";
import { RuntimesPage } from "@/features/runtime";
import { SettingsPage } from "@/features/setting";
import { ToastHost } from "@/ui/ToastHost";
import { Navigate } from "@/ui/A";
import { Follow } from "@/features/notice";
import { Root } from "./Root";
import { Keyed } from "@/base/util";
import { ready, useProjects } from "@/base/query";
import { farmState } from "@/farm/store";
import { useRouter } from "@/base/router";
import { Shell } from "./Shell";
import { places as placeList } from "./places";
import { prefsNow } from "@/base/prefs";
import { WindowStrip } from "@/ui/TitleBar";

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
  projects: (rest) => <ProjectsPage rest={rest()} />,
  catalog: (rest) => <CatalogPage rest={rest()} />,
  artifacts: (rest) => <ArtifactsPage rest={rest()} />,
};

/**
 * `/farm`: the farm entered last on this machine (trusted while the projects are still coming); without one, the farm of
 * the project worked on last, so 回农场 always lands on a farm; with no project yet, the farm of the sessions without one.
 */
function FarmHome() {
  const projects = useProjects();
  const last = farmState().project;
  const list = () => ready(projects, undefined);
  const enter = (name: string) => <Navigate href={`/farm/${encodeURIComponent(name)}`} />;
  return (
    <Switch>
      <Match when={last && (!list() || list()!.some((p) => p.name === last))}>{enter(last!)}</Match>
      <Match when={list()?.length === 0 || projects.isError}>
        <FarmPage project="" />
      </Match>
      {/* Entered once, by the list as it is now. */}
      <Match when={list()}>{(all) => enter(untrack(() => sortProjects(all())[0]!.name))}</Match>
    </Switch>
  );
}

function Routes() {
  const router = useRouter();
  const pathname = () => router.path().split("?")[0]!;
  const place = () => pathname().split("/")[1] ?? "";
  const rest = () => pathname().split("/").slice(2).join("/");
  return (
    <Switch fallback={<Navigate href="/" />}>
      {/* Where this machine opens (设置 › 通用): the workbench unless the owner chose the farm. */}
      <Match when={pathname() === "/"}>
        <Navigate href={prefsNow().start === "farm" ? "/farm" : placeList[0]!.path} />
      </Match>
      {/* Before the farms by project: /farm/ (empty) is the farm of the sessions without one. */}
      <Match when={pathname() === "/farm"}>
        <FarmHome />
      </Match>
      <Match when={place() === "farm"}>
        {/* One farm per project: entering another builds its farm anew. */}
        <Keyed key={decodeURIComponent(rest())}>{() => <FarmPage project={untrack(() => decodeURIComponent(rest()))} />}</Keyed>
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
          <Show when={place()} keyed>
            {(p) => places[p]!(rest)}
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
