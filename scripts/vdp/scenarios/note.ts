import { defineScenario } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

export const noteScenario = defineScenario({
  id: "note",
  description: "3+1 Note editorial audit (Doc, HR & Delivery Base, Dual Whiteboards, Media, Presenter, IssueNotes) with minimal Dark sample",
  async run(v) {
    const ids = await seedNoteShowcase(v);
    const primaryTheme = v.defaultThemes[0] ?? "light";
    const includeDarkSample = v.defaultThemes.length > 1 && v.defaultThemes.includes("dark");

    await v.resize(v.viewport.width, v.viewport.height);
    await v.theme(primaryTheme);
    await v.nav("/issues");
    await v.waitRoute("/issues");
    await v.wait("place-content");
    await v.press("place-content");
    await v.waitRoute("/library");
    await v.wait("library-page");

    await v.nav(`/notes/${ids.docId}`);
    await v.waitRoute(`/notes/${ids.docId}`);
    await v.wait("note-block-doc-view");
    await v.assertClean(`doc-top-${primaryTheme}`);
    await v.shot(`01-doc-top-${primaryTheme}`, { label: `Engineering & People Ops Handbook (${primaryTheme})`, settleMs: 80 });

    await v.nav(`/notes/${ids.hrBaseId}`);
    await v.waitRoute(`/notes/${ids.hrBaseId}`);
    await v.wait("note-base-view");
    await v.wait("base-table-view");
    await v.assertClean(`hr-recruiting-base-${primaryTheme}`);
    await v.shot(`05-hr-recruiting-base-${primaryTheme}`, { label: `2026 Autumn Recruiting & Offer Pipeline Base (${primaryTheme})`, settleMs: 80 });

    await v.nav(`/notes/${ids.baseId}`);
    await v.waitRoute(`/notes/${ids.baseId}`);
    await v.wait("note-base-view");
    await v.wait("base-table-view");
    await v.assertClean(`base-table-${primaryTheme}`);
    await v.shot(`06-base-table-${primaryTheme}`, { label: `R&D and HR Delivery Base Table (${primaryTheme})`, settleMs: 80 });

    await v.nav(`/notes/${ids.canvasId}`);
    await v.waitRoute(`/notes/${ids.canvasId}`);
    await v.wait("note-canvas-view");
    await v.assertClean(`canvas-${primaryTheme}`);
    await v.shot(`09-canvas-${primaryTheme}`, { label: `Gateway High-Availability Architecture Whiteboard (${primaryTheme})`, settleMs: 180 });

    await v.nav(`/notes/${ids.hrCanvasId}`);
    await v.waitRoute(`/notes/${ids.hrCanvasId}`);
    await v.wait("note-canvas-view");
    await v.assertClean(`hr-onboarding-canvas-${primaryTheme}`);
    await v.shot(`09b-hr-onboarding-canvas-${primaryTheme}`, { label: `Recruiting Offer & Onboarding Flow Whiteboard (${primaryTheme})`, settleMs: 180 });

    await v.nav(`/notes/${ids.mediaId}`);
    await v.waitRoute(`/notes/${ids.mediaId}`);
    await v.wait("note-media-view");
    await v.assertClean(`media-${primaryTheme}`);
    await v.shot(`10-media-${primaryTheme}`, { label: `Weekly Cross-Team Sync Media & Transcript (${primaryTheme})`, settleMs: 80 });

    await v.nav(`/notes/${ids.reviewDocId}`);
    await v.waitRoute(`/notes/${ids.reviewDocId}`);
    await v.wait("media-annot-pin-ann_1");
    await v.press("media-annot-pin-ann_1");
    await v.wait("media-annot-popover-ann_1");
    await v.assertClean(`review-annotations-${primaryTheme}`);
    await v.shot(`13-review-annotations-${primaryTheme}`, {
      label: `Console Review Mockup Annotations & Checklist (${primaryTheme})`,
      settleMs: 90,
    });

    if (includeDarkSample) {
      await v.theme("dark");
      await v.nav(`/notes/${ids.docId}`);
      await v.waitRoute(`/notes/${ids.docId}`);
      await v.wait("note-block-doc-view");
      await v.assertClean("doc-top-dark");
      await v.shot("01-doc-top-dark", { label: "Block Doc Editorial View (dark)", settleMs: 90 });
      await v.theme(primaryTheme);
    }

    await v.nav(`/notes/${ids.docId}`);
    await v.waitRoute(`/notes/${ids.docId}`);
    await v.wait("doc-prose-rich-b2");
    await v.press("doc-prose-rich-b2");
    await v.settle(40);
    await v.key("cmd-a");
    await v.wait("doc-format-bar-b2");
    await v.shot(`03-doc-active-format-${primaryTheme}`, { label: "Doc Active Selection & Floating Format Bar", settleMs: 70 });

    await v.nav(`/notes/${ids.docId}`);
    await v.waitRoute(`/notes/${ids.docId}`);
    await v.wait("doc-links-panel");
    await v.key("end");
    await v.shot(`02-doc-embeds-backlinks-${primaryTheme}`, { label: "Doc Embeds & Backlinks", settleMs: 70 });

    await v.nav(`/notes/${ids.baseId}`);
    await v.waitRoute(`/notes/${ids.baseId}`);
    await v.wait("base-view-switcher-board");
    await v.press("base-view-switcher-board");
    await v.wait("base-board-view");
    await v.shot(`07-base-board-${primaryTheme}`, { label: "Base Kanban Board View", settleMs: 70 });

    await v.press("base-view-switcher-gallery");
    await v.wait("base-gallery-view");
    await v.shot(`07b-base-gallery-${primaryTheme}`, { label: "Base Gallery Cards View", settleMs: 70 });

    await v.press("base-view-switcher-timeline");
    await v.wait("base-timeline-view");
    await v.shot(`07c-base-timeline-${primaryTheme}`, { label: "Base Timeline View", settleMs: 70 });

    await v.press("base-view-switcher-table");
    await v.wait("base-row-open-r1");
    await v.press("base-row-open-r1");
    await v.wait("base-row-drawer-title");
    await v.shot(`08-base-row-drawer-${primaryTheme}`, { label: "Base Row = Page Drawer", settleMs: 70 });

    await v.nav(`/present?note=${encodeURIComponent(ids.docId)}`);
    await v.waitRoute("/present");
    await v.wait("presenter-page");
    await v.assertClean(`presenter-${primaryTheme}`);
    await v.shot(`12-presenter-${primaryTheme}`, { label: "Doc Presenter Mode & Speaker Notes", settleMs: 70 });

    await v.nav(`/notes/${ids.reviewDocId}`);
    await v.waitRoute(`/notes/${ids.reviewDocId}`);
    await v.wait("doc-base-embed-row-rev_base-rev_2");
    await v.press("doc-base-embed-row-rev_base-rev_2");
    await v.wait("media-annot-popover-ann_2");
    await v.assertClean(`review-bidirectional-${primaryTheme}`);
    await v.shot(`14-review-bidirectional-${primaryTheme}`, {
      label: "BaseEmbed Row -> MediaAnnotation Bidirectional Jump & Table",
      settleMs: 90,
    });

    await v.nav(`/issues/${ids.issueIds[1]}`);
    await v.waitRoute(`/issues/${ids.issueIds[1]}`);
    await v.wait("issue-notes");
    await v.assertClean(`issue-notes-${primaryTheme}`);
    await v.shot(`11-issue-notes-${primaryTheme}`, { label: "Issue Linked Notes Panel", settleMs: 70 });
  },
});
