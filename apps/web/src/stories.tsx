import { render, type JSX } from "@solidjs/web";
import { Loading } from "solid-js";

import { LocaleValues } from "@vibevalley/i18n";
import { StoriesApp, type Stories } from "@vibevalley/stories";

import { FramesContext } from "./infra/frame";
import { agentsQuery, templatesQuery, reposQuery, runtimesQuery, createQueryClient, QueryProvider } from "./infra/query";
import { memoryHistory, Router } from "./infra/router";
import { fakeFetch } from "./infra/storyApi";
import { createRegistry, RegistryContext } from "./state/atom";
import { order } from "./storyLevels";

import "./stories.css";

const found = import.meta.glob<{ default: Stories }>("./**/*.stories.tsx", { eager: true });

window.fetch = fakeFetch(window.fetch.bind(window));
function StoryQueries(props: { children: JSX.Element }) {
  const client = createQueryClient();
  client.setData(agentsQuery(), () => ({ value: [] }));
  client.setData(templatesQuery(), () => ({ value: [] }));
  client.setData(reposQuery(), () => ({ value: [] }));
  client.setData(runtimesQuery(), () => ({ value: [] }));
  return <QueryProvider client={client}>{props.children}</QueryProvider>;
}

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const follow = () => (document.documentElement.dataset.theme = dark.matches ? "dark" : "light");
follow();
dark.addEventListener("change", follow);

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StoriesApp
        stories={Object.values(found).map((m) => m.default)}
        order={order}
        locales={LocaleValues}
        wrap={(story) => (
          <Router history={memoryHistory()}>
            <FramesContext value={{ frame: undefined, link: "open", count: 0 }}>
              <RegistryContext value={createRegistry()}>
                <StoryQueries>
                  <Loading>{story()}</Loading>
                </StoryQueries>
              </RegistryContext>
            </FramesContext>
          </Router>
        )}
      />
    ),
    root,
  );
