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
  title: "组件/工作台/Button", // a path: folders, then the file
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

## Titles and the tree

A title is a path: `组件/工作台/Button`. Every part but the last is a folder; the last holds the file's stories, or, for a
file of one story, is that story. `StoriesApp`'s `order` lists paths to put first at each depth (`["设计体系", "组件",
"组件/工作台"]`); the rest go by name. The levels and the open story's folders start open, a search opens what it finds,
and folders opened or closed by hand stay so in this browser (`localStorage`, if it is there). The tree's rules are
`tree.ts`, tested on their own.

## The viewer

`StoriesApp({ stories, order, wrap })`. The toolbar is reicon's icons: light, dark, both; full width, phone (400),
tablet (720), laptop (1280); a copy of the link. The address holds the view (`?s=<title>:<name>&theme=light|dark|both&w=full|400|720|1280`),
so a link opens the same thing. Each frame carries `data-theme` and contains its layout, so a part fixed to the window
(a toast) stays in its frame; a modal `<dialog>` still opens over everything. A story that throws shows its error in its
frame (`data-testid="story-error"`), not a blank page. The viewer's own words are English: it is a tool for whoever
writes the parts, not shipped to the owner.

Test ids: `stories-tree`, `stories-search`, `story-folder` (`data-key` the path, `aria-expanded`), `story-link` (`data-key`), `story-canvas`, `story-frame` (`data-theme`),
`story-theme`, `story-width` (`data-value` on each), `story-copy-link`, `story-args`, `story-arg` (`data-name`), `story-reset`, `story-error`.
