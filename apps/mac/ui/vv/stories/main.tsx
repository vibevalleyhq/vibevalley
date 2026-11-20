// The ported VibeValley pages as stories, one per `host.params.story`;
// `host.params.locale` picks zh (default) or en.
import "../polyfill";
import { host, mount, View } from "nsh";

import { setLocale } from "@vibevalley/i18n";

setLocale(host.params.locale === "en" ? "en" : "zh");

const { BoardStory } = await import("./board.story");
const { MarkdownStory } = await import("./markdown.story");

const stories: Record<string, () => unknown> = {
  board: () => <BoardStory />,
  "board-loading": () => <BoardStory loading />,
  markdown: () => <MarkdownStory />,
};

const storyKey = typeof host.params.story === "string" ? host.params.story : "board";
mount(() => <View class="flex-1 bg-page pt-3">{(stories[storyKey] ?? stories.board)() as never}</View>);
