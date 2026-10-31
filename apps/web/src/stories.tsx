import { render } from "@solidjs/web";
import { QueryClientProvider } from "@tanstack/solid-query";
import { createSignal, Loading } from "solid-js";

import { LocaleValues } from "@vibevalley/i18n";
import { StoriesApp, type Stories } from "@vibevalley/stories";

import { createRegistry, RegistryContext } from "./base/atom";
import { FramesContext } from "./base/frame";
import { queries } from "./base/query";
import { RouterContext, type Router } from "./base/router";
import { fakeFetch } from "./base/storyApi";
import { order } from "./storyLevels";

import "./stories.css";

const found = import.meta.glob<{ default: Stories }>("./**/*.stories.tsx", { eager: true });

window.fetch = fakeFetch(window.fetch.bind(window));
queries.setDefaultOptions({ queries: { retry: false, staleTime: Infinity, refetchInterval: false } });
const fresh = () => {
  queries.clear();
  for (const key of ["agents", "agent-templates", "projects", "runtimes"]) queries.setQueryData([key], []);
};

const still = (): Router => {
  const [path, setPath] = createSignal("/");
  return { path, navigate: (to) => setPath(to) };
};

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const follow = () => (document.documentElement.dataset.theme = dark.matches ? "dark" : "light");
follow();
dark.addEventListener("change", follow);

render(
  () => (
    <StoriesApp
      stories={Object.values(found).map((m) => m.default)}
      order={order}
      locales={LocaleValues}
      prepare={fresh}
      wrap={(story) => (
        <RouterContext value={still()}>
          <FramesContext value={{ frame: undefined, link: "open", count: 0 }}>
            <RegistryContext value={createRegistry()}>
              <QueryClientProvider client={queries}>
                <Loading>{story()}</Loading>
              </QueryClientProvider>
            </RegistryContext>
          </FramesContext>
        </RouterContext>
      )}
    />
  ),
  document.getElementById("root")!,
);
