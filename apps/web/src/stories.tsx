// A router that goes nowhere, so a link in a part does not move the viewer; the farm's lists are known up front: there
// is no server behind the stories.

import { render } from "@solidjs/web";
import { createSignal, Loading } from "solid-js";
import { QueryClientProvider } from "@tanstack/solid-query";
import { StoriesApp, type Stories } from "@vibevalley/stories";
import { queries } from "./base/query";
import { RouterContext, type Router } from "./base/router";
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
      order={["ui", "pixel"]}
      wrap={(story) => (
        <RouterContext value={still()}>
          <QueryClientProvider client={queries}>
            <Loading>{story()}</Loading>
          </QueryClientProvider>
        </RouterContext>
      )}
    />
  ),
  document.getElementById("root")!,
);
