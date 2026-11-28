import { defineScenario } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

export const noteScenario = defineScenario({
  id: "note",
  description: "3+1 Note editorial audit (Doc, Base table/board/gallery/timeline/drawer, Canvas, Media, Presenter, IssueNotes) in Light & Dark",
  async run(v) {
    const ids = await seedNoteShowcase(v);
    await v.resize(v.viewport.width, v.viewport.height);

    // Theme matrix: static layout across Doc, Base Table, Canvas, and Media
    await v.forThemes(undefined, async (theme) => {
      await v.nav(`/notes/${ids.docId}`);
      await v.waitRoute(`/notes/${ids.docId}`);
      await v.wait("note-block-doc-view");
      await v.assertClean(`doc-top-${theme}`);
      await v.shot(`01-doc-top-${theme}`, { label: `Block Doc Editorial View (${theme})` });

      await v.nav(`/notes/${ids.baseId}`);
      await v.waitRoute(`/notes/${ids.baseId}`);
      await v.wait("note-base-view");
      await v.wait("base-table-view");
      await v.assertClean(`base-table-${theme}`);
      await v.shot(`06-base-table-${theme}`, { label: `Base Table View (${theme})` });

      await v.nav(`/notes/${ids.canvasId}`);
      await v.waitRoute(`/notes/${ids.canvasId}`);
      await v.wait("note-canvas-view");
      await v.assertClean(`canvas-${theme}`);
      await v.shot(`09-canvas-${theme}`, { label: `Canvas Whiteboard (${theme})`, settleMs: 320 });

      await v.nav(`/notes/${ids.mediaId}`);
      await v.waitRoute(`/notes/${ids.mediaId}`);
      await v.wait("note-media-view");
      await v.assertClean(`media-${theme}`);
      await v.shot(`10-media-${theme}`, { label: `Media Transcript & Preview View (${theme})` });

      // Phase 1 & 2 (#144 / #145): Interactive MediaAnnotation overlay + linked BaseEmbed checklist + Table
      await v.nav(`/notes/${ids.reviewDocId}`);
      await v.waitRoute(`/notes/${ids.reviewDocId}`);
      await v.wait("media-annot-pin-ann_1");
      await v.press("media-annot-pin-ann_1");
      await v.wait("media-annot-popover-ann_1");
      await v.assertClean(`review-annotations-${theme}`);
      await v.shot(`13-review-annotations-${theme}`, {
        label: `Interactive MediaAnnotation + BaseEmbed Review Checklist (${theme})`,
        settleMs: 180,
      });
    });

    // Interactive checks in Light mode
    await v.theme("light");

    await v.nav(`/notes/${ids.docId}`);
    await v.waitRoute(`/notes/${ids.docId}`);
    await v.wait("doc-prose-rich-b2");
    await v.press("doc-prose-rich-b2");
    await v.wait("doc-format-bar-b2");
    await v.shot("03-doc-active-format-light", { label: "Doc Active Block & Inline Format Bar" });

    // Jump to lower section embeds & backlinks
    await v.nav(`/notes/${ids.docId}`);
    await v.waitRoute(`/notes/${ids.docId}`);
    await v.wait("doc-links-panel");
    await v.key("end");
    await v.shot("02-doc-embeds-backlinks-light", { label: "Doc Embeds & Backlinks" });

    // Base Board / Gallery / Timeline switch & Row=Page Drawer
    await v.nav(`/notes/${ids.baseId}`);
    await v.waitRoute(`/notes/${ids.baseId}`);
    await v.wait("base-view-switcher-board");
    await v.press("base-view-switcher-board");
    await v.wait("base-board-view");
    await v.shot("07-base-board-light", { label: "Base Kanban Board View" });

    await v.press("base-view-switcher-gallery");
    await v.wait("base-gallery-view");
    await v.shot("07b-base-gallery-light", { label: "Base Gallery Cards View" });

    await v.press("base-view-switcher-timeline");
    await v.wait("base-timeline-view");
    await v.shot("07c-base-timeline-light", { label: "Base Timeline View" });

    await v.press("base-view-switcher-table");
    await v.wait("base-row-open-r1");
    await v.press("base-row-open-r1");
    await v.wait("base-row-drawer-title");
    await v.shot("08-base-row-drawer-light", { label: "Base Row = Page Drawer" });

    // Presenter Mode for multi-slide Doc
    await v.nav(`/present?note=${encodeURIComponent(ids.docId)}`);
    await v.waitRoute("/present");
    await v.wait("presenter-page");
    await v.assertClean("presenter-light");
    await v.shot("12-presenter-light", { label: "Doc Presenter Mode & Speaker Notes" });

    // Bidirectional BaseEmbed Row -> MediaAnnotation Pin jump + Table editing in Light mode
    await v.nav(`/notes/${ids.reviewDocId}`);
    await v.waitRoute(`/notes/${ids.reviewDocId}`);
    await v.wait("doc-base-embed-row-rev_base-rev_2");
    await v.press("doc-base-embed-row-rev_base-rev_2");
    await v.wait("media-annot-popover-ann_2");
    await v.assertClean("review-bidirectional-light");
    await v.shot("14-review-bidirectional-light", {
      label: "BaseEmbed Row -> MediaAnnotation Bidirectional Jump & Table",
      settleMs: 160,
    });

    // Issue <-> Note Bidirectional Sidebar
    await v.nav(`/issues/${ids.issueIds[1]}`);
    await v.waitRoute(`/issues/${ids.issueIds[1]}`);
    await v.wait("issue-notes");
    await v.assertClean("issue-notes-light");
    await v.shot("11-issue-notes-light", { label: "Issue Linked Notes Panel" });
  },
});
