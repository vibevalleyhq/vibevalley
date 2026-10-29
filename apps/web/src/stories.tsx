// There is no server: the router goes nowhere, so a link in a part does not move the viewer, and the lists and the state
// start empty. A story that wants data passes it to the part.

import { render } from "@solidjs/web";
import { createSignal, Loading } from "solid-js";
import { QueryClientProvider } from "@tanstack/solid-query";
import { StoriesApp, type Stories } from "@vibevalley/stories";
import { queries } from "./base/query";
import { FramesContext } from "./base/frame";
import { RouterContext, type Router } from "./base/router";
import { order } from "./storyLevels";
import "./stories.css";

const found = import.meta.glob<{ default: Stories }>("./**/*.stories.tsx", { eager: true });

queries.setDefaultOptions({ queries: { retry: false, staleTime: Infinity, refetchInterval: false } });
for (const key of ["agents", "agent-templates", "projects", "runtimes"]) queries.setQueryData([key], []);

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
      wrap={(story) => (
        <RouterContext value={still()}>
          <FramesContext value={{ frame: undefined, link: "open", count: 0 }}>
            <QueryClientProvider client={queries}>
              <Loading>{story()}</Loading>
            </QueryClientProvider>
          </FramesContext>
        </RouterContext>
      )}
    />
  ),
  document.getElementById("root")!,
);
