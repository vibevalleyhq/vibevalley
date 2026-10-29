# @vibevalley/stories

Stories for Solid 2 parts, after Storybook: a part's states drawn one by one with made-up arguments, in a viewer with a
tree, a canvas and an arguments panel. Storybook's Solid renderer is for Solid 1 and brings its own build; this is the
little of it the workbench uses, on the host's own Vite, Tailwind and tokens.

The package knows no app. The host (`apps/web/src/stories.tsx`) collects its `*.stories.tsx`, gives the viewer what
every story is drawn inside (`wrap`: a router, a query cache) and its stylesheet; the viewer is drawn with the host's
token classes (`bg-page`, `border-line`…), so the host's Tailwind scans `src/` here (`@source`).

## A stories file

```tsx
import { stories, story } from "@vibevalley/stories";
import { Button, type Tone } from "./Button";

export default stories({
  title: "ui/Button", // the first part is the group in the tree
  stories: {
    Playground: story({
      args: { label: "派活", tone: "primary", disabled: false },
      controls: { tone: { kind: "choice", options: ["plain", "primary", "quiet", "danger"] } },
      render: (a, set) => (
        <Button tone={a.tone as Tone} disabled={a.disabled}>
          {a.label}
        </Button>
      ),
    }),
  },
});
```

| Field | What it does |
|---|---|
| `render(args, set)` | Called once each time the story opens. `args` is a store: read it inside JSX to follow the panel. `set` writes back (a toggle that was clicked), so the panel and the part agree. |
| `args` | Plain values (text, number, boolean): what the panel edits. Their types are taken from here. |
| `controls` | `text` (`long` for a textarea), `boolean`, `number` (`min`, `max`, `step`), `choice` (`options`); without one, the value's type picks. |
| `note` | One line under the story's name: what to look at. |
| `fill` | Lay it out as a pane fills its space, not centred at its own size. |

A file may say `themes: ["light"]` and `frame: "<classes>"` for parts with colours of their own (the pixel skin), drawn on
their own ground in their one theme.

## The viewer

`StoriesApp({ stories, order, wrap })`. The address holds the view (`?s=<title>:<name>&theme=light|dark|both&w=full|400|720|1280`),
so a link opens the same thing. Each frame carries `data-theme` and contains its layout, so a part fixed to the window
(a toast) stays in its frame; a modal `<dialog>` still opens over everything. A story that throws shows its error in its
frame (`data-testid="story-error"`), not a blank page. The viewer's own words are English: it is a tool for whoever
writes the parts, not shipped to the owner.

Test ids: `stories-tree`, `stories-search`, `story-link` (`data-key`), `story-canvas`, `story-frame` (`data-theme`),
`story-theme`, `story-width` (`data-value` on each), `story-args`, `story-arg` (`data-name`), `story-reset`, `story-error`.
