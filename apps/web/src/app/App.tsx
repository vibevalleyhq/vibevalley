// The page's routes. The farm is full-bleed, outside the workbench's shell; the shell links back to it. Each workbench
// place gets the rest of the path after its own (/issues/<id> → "<id>").

import { Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ChatPage } from "../pages/chat/ChatPage";
import { FarmPage } from "../farm/FarmPage";
import { AgentsRoute } from "../pages/agents/AgentsPage";
import { CatalogPage } from "../pages/catalog/CatalogPage";
import { DocsPage } from "../pages/docs/DocsPage";
import { IssuesPage } from "../pages/issues/IssuesPage";
import { ManagerPage } from "../pages/manager/ManagerPage";
import { PairPage } from "../pages/pair/PairPage";
import { ProjectsPage } from "../pages/projects/ProjectsPage";
import { RuntimesPage } from "../pages/runtimes/RuntimesPage";
import { SettingsPage } from "../pages/settings/SettingsPage";
import { ToastHost } from "../ui/ToastHost";
import { Navigate } from "./A";
import { Follow } from "./Follow";
import { Root } from "./Root";
import { useRouter } from "./router";
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
  manager: (rest) => <ManagerPage rest={rest()} />,
  agents: (rest) => <AgentsRoute rest={rest()} />,
  runtimes: (rest) => <RuntimesPage rest={rest()} />,
  projects: (rest) => <ProjectsPage rest={rest()} />,
  docs: (rest) => <DocsPage rest={rest()} />,
  catalog: (rest) => <CatalogPage rest={rest()} />,
};

function Routes() {
  const router = useRouter();
  const pathname = () => router.path().split("?")[0]!;
  const place = () => pathname().split("/")[1] ?? "";
  const rest = () => pathname().split("/").slice(2).join("/");
  return (
    <Switch fallback={<Navigate href="/" />}>
      <Match when={pathname() === "/"}>
        <FarmPage />
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
      <Follow />
      <Routes />
      <ToastHost />
    </Root>
  );
}
