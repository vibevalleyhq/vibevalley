import { render } from "@solidjs/web";

import { StoriesApp, stories, story } from "@vibevalley/stories";

import "virtual:viewer-host.css";

const theme = new URLSearchParams(location.search).get("theme");
document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";

const controls = story({
  args: { enabled: true, count: 3, choice: "alpha", title: "A shared fixture", description: "The same catalogue, arguments and content in both builds." },
  controls: {
    count: { kind: "number", min: 0, max: 10, step: 1 },
    choice: { kind: "choice", options: ["alpha", "beta"] },
    description: { kind: "text", long: true },
  },
  render: (args) => (
    <section>
      <h2>{args.title}</h2>
      <p>{args.description}</p>
      <p>{`${args.enabled ? "Enabled" : "Disabled"}: ${args.count} / ${args.choice}`}</p>
    </section>
  ),
});

const catalogue = [
  stories({ title: "Viewer/Controls", stories: { Inputs: controls } }),
  stories({ title: "Viewer/Another folder", stories: { Example: story({ render: () => <p>Another part</p> }) } }),
];

const root = document.getElementById("root");
if (root === null) throw new Error("Missing fixture root");
render(() => <StoriesApp stories={catalogue} locales={["en", "zh-CN"]} />, root);
