import { t } from "@vibevalley/i18n";
import type { ArtifactType } from "@vibevalley/protocol";

import type { IconName } from "../../design/icons";
import { api } from "../../infra/api";
import type { QueryClient } from "../../infra/query";
import type { RouterController } from "../../infra/router/context";
import { artifactTypeIcon, createTypedArtifact } from "../artifact";
import { artifactHref } from "../artifact/ArtifactCard";
import { buildOutlineFromMarkdown } from "../artifact/html";
import { BOARD_FILE_PATH } from "../artifact/WhiteboardView";
import type { TemplateCategory } from "./navigation";

type NoteTemplateVariant = "blank" | "tech" | "meeting" | "daily";
type WhiteboardTemplateVariant = "blank" | "arch" | "timeline" | "journey" | "workshop";
type AiMediaMakeTab = "image" | "speech" | "audio";

type TemplateItemKey =
  | "noteBlank"
  | "noteTech"
  | "noteMeeting"
  | "noteDaily"
  | "wbBlank"
  | "wbArch"
  | "wbTimeline"
  | "wbJourney"
  | "wbWorkshop"
  | "artDocs"
  | "artSlides"
  | "artDashboard"
  | "artDesign"
  | "artDesignSystem"
  | "artMotion"
  | "artHtml"
  | "artSheet"
  | "artDiagram"
  | "artStoryboard"
  | "aiImage"
  | "aiSpeech"
  | "aiAudio";

interface TemplateBase {
  readonly id: string;
  readonly key: TemplateItemKey;
  readonly category: Exclude<TemplateCategory, "recommended">;
  readonly recommended: boolean;
  readonly icon: IconName;
}

export type ContentTemplate =
  | (TemplateBase & { readonly kind: "note"; readonly variant: NoteTemplateVariant })
  | (TemplateBase & { readonly kind: "whiteboard"; readonly variant: WhiteboardTemplateVariant })
  | (TemplateBase & { readonly kind: "deliverable"; readonly artifactType: Exclude<ArtifactType, "whiteboard"> })
  | (TemplateBase & { readonly kind: "ai"; readonly makeTab: AiMediaMakeTab });

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = ["recommended", "note", "whiteboard", "deliverable", "ai"];

export const CONTENT_TEMPLATES: readonly ContentTemplate[] = [
  { id: "tpl-note-blank", key: "noteBlank", category: "note", recommended: true, icon: "notes", kind: "note", variant: "blank" },
  { id: "tpl-note-tech", key: "noteTech", category: "note", recommended: true, icon: "issues", kind: "note", variant: "tech" },
  { id: "tpl-note-meeting", key: "noteMeeting", category: "note", recommended: false, icon: "chat", kind: "note", variant: "meeting" },
  { id: "tpl-note-daily", key: "noteDaily", category: "note", recommended: false, icon: "calendar", kind: "note", variant: "daily" },
  { id: "tpl-wb-blank", key: "wbBlank", category: "whiteboard", recommended: true, icon: artifactTypeIcon.whiteboard, kind: "whiteboard", variant: "blank" },
  { id: "tpl-wb-arch", key: "wbArch", category: "whiteboard", recommended: true, icon: artifactTypeIcon.whiteboard, kind: "whiteboard", variant: "arch" },
  {
    id: "tpl-wb-timeline",
    key: "wbTimeline",
    category: "whiteboard",
    recommended: false,
    icon: artifactTypeIcon.whiteboard,
    kind: "whiteboard",
    variant: "timeline",
  },
  {
    id: "tpl-wb-journey",
    key: "wbJourney",
    category: "whiteboard",
    recommended: false,
    icon: artifactTypeIcon.whiteboard,
    kind: "whiteboard",
    variant: "journey",
  },
  {
    id: "tpl-wb-workshop",
    key: "wbWorkshop",
    category: "whiteboard",
    recommended: false,
    icon: artifactTypeIcon.whiteboard,
    kind: "whiteboard",
    variant: "workshop",
  },
  { id: "tpl-art-docs", key: "artDocs", category: "deliverable", recommended: true, icon: artifactTypeIcon.docs, kind: "deliverable", artifactType: "docs" },
  {
    id: "tpl-art-slides",
    key: "artSlides",
    category: "deliverable",
    recommended: true,
    icon: artifactTypeIcon.slides,
    kind: "deliverable",
    artifactType: "slides",
  },
  {
    id: "tpl-art-dashboard",
    key: "artDashboard",
    category: "deliverable",
    recommended: false,
    icon: artifactTypeIcon.dashboard,
    kind: "deliverable",
    artifactType: "dashboard",
  },
  {
    id: "tpl-art-design",
    key: "artDesign",
    category: "deliverable",
    recommended: false,
    icon: artifactTypeIcon.design,
    kind: "deliverable",
    artifactType: "design",
  },
  {
    id: "tpl-art-design-system",
    key: "artDesignSystem",
    category: "deliverable",
    recommended: false,
    icon: artifactTypeIcon["design-system"],
    kind: "deliverable",
    artifactType: "design-system",
  },
  {
    id: "tpl-art-motion",
    key: "artMotion",
    category: "deliverable",
    recommended: false,
    icon: artifactTypeIcon.motion,
    kind: "deliverable",
    artifactType: "motion",
  },
  {
    id: "tpl-art-prototype",
    key: "artHtml",
    category: "deliverable",
    recommended: false,
    icon: artifactTypeIcon.prototype,
    kind: "deliverable",
    artifactType: "prototype",
  },
  {
    id: "tpl-art-sheet",
    key: "artSheet",
    category: "deliverable",
    recommended: false,
    icon: artifactTypeIcon.sheet,
    kind: "deliverable",
    artifactType: "sheet",
  },
  {
    id: "tpl-art-diagram",
    key: "artDiagram",
    category: "deliverable",
    recommended: false,
    icon: artifactTypeIcon.diagram,
    kind: "deliverable",
    artifactType: "diagram",
  },
  {
    id: "tpl-art-storyboard",
    key: "artStoryboard",
    category: "deliverable",
    recommended: false,
    icon: artifactTypeIcon.storyboard,
    kind: "deliverable",
    artifactType: "storyboard",
  },
  { id: "tpl-ai-image", key: "aiImage", category: "ai", recommended: true, icon: "image", kind: "ai", makeTab: "image" },
  { id: "tpl-ai-speech", key: "aiSpeech", category: "ai", recommended: false, icon: "record", kind: "ai", makeTab: "speech" },
  { id: "tpl-ai-audio", key: "aiAudio", category: "ai", recommended: false, icon: "audio", kind: "ai", makeTab: "audio" },
];

export const templateName = (tpl: ContentTemplate): string => {
  switch (tpl.key) {
    case "artSheet":
      return "Workbook Sheet";
    case "artDiagram":
      return "Architecture Diagram";
    case "artStoryboard":
      return "Storyboard Shots";
    default:
      return t(`web.library.content.templates.items.${tpl.key}.name`);
  }
};

export const templateDesc = (tpl: ContentTemplate): string => {
  switch (tpl.key) {
    case "artSheet":
      return "Multi-sheet structured tables and CSV export";
    case "artDiagram":
      return "Nodes, edges, and architecture flows";
    case "artStoryboard":
      return "Shot list, framing, palette, and dialogue";
    default:
      return t(`web.library.content.templates.items.${tpl.key}.desc`);
  }
};

function uniqueNoteTitle(base: string, existingTitles: readonly string[]): string {
  const taken = new Set(existingTitles.map((s) => s.trim().toLowerCase()));
  if (!taken.has(base.trim().toLowerCase())) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

function noteStarterMarkdown(variant: NoteTemplateVariant): string {
  switch (variant) {
    case "blank":
      return "- \n";
    case "tech":
      return t("web.library.content.templates.seed.noteTech");
    case "meeting":
      return t("web.library.content.templates.seed.noteMeeting");
    case "daily":
      return t("web.library.content.templates.seed.noteDaily");
  }
}

interface SeedShape {
  readonly id: string;
  readonly shape: "card" | "sticky";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly title: string;
  readonly body: string;
  readonly fill: "default" | "sun" | "peach" | "leaf" | "water" | "lavender" | "side";
}

interface SeedArrow {
  readonly id: string;
  readonly fromId: string;
  readonly fromSide: "n" | "e" | "s" | "w";
  readonly toId: string;
  readonly toSide: "n" | "e" | "s" | "w";
  readonly label?: string;
}

function buildWhiteboardDocument(variant: WhiteboardTemplateVariant): Record<string, unknown> {
  const shapes: SeedShape[] = [];
  const arrows: SeedArrow[] = [];

  switch (variant) {
    case "blank":
      shapes.push({
        id: "n1",
        shape: "card",
        x: 240,
        y: 160,
        w: 220,
        h: 108,
        title: t("web.library.content.templates.seed.wbBlankTitle"),
        body: t("web.library.content.templates.seed.wbBlankBody"),
        fill: "leaf",
      });
      break;
    case "arch":
      shapes.push(
        {
          id: "n1",
          shape: "card",
          x: 80,
          y: 140,
          w: 200,
          h: 112,
          title: t("web.library.content.templates.seed.wbArchN1Title"),
          body: t("web.library.content.templates.seed.wbArchN1Body"),
          fill: "default",
        },
        {
          id: "n2",
          shape: "card",
          x: 348,
          y: 140,
          w: 210,
          h: 112,
          title: t("web.library.content.templates.seed.wbArchN2Title"),
          body: t("web.library.content.templates.seed.wbArchN2Body"),
          fill: "leaf",
        },
        {
          id: "n3",
          shape: "card",
          x: 626,
          y: 140,
          w: 200,
          h: 112,
          title: t("web.library.content.templates.seed.wbArchN3Title"),
          body: t("web.library.content.templates.seed.wbArchN3Body"),
          fill: "water",
        },
      );
      arrows.push(
        { id: "a1", fromId: "n1", fromSide: "e", toId: "n2", toSide: "w", label: t("web.library.content.templates.seed.wbArchE1") },
        { id: "a2", fromId: "n2", fromSide: "e", toId: "n3", toSide: "w", label: t("web.library.content.templates.seed.wbArchE2") },
      );
      break;
    case "timeline":
      shapes.push(
        {
          id: "p1",
          shape: "card",
          x: 80,
          y: 140,
          w: 200,
          h: 112,
          title: t("web.library.content.templates.seed.wbTlP1Title"),
          body: t("web.library.content.templates.seed.wbTlP1Body"),
          fill: "sun",
        },
        {
          id: "p2",
          shape: "card",
          x: 348,
          y: 140,
          w: 200,
          h: 112,
          title: t("web.library.content.templates.seed.wbTlP2Title"),
          body: t("web.library.content.templates.seed.wbTlP2Body"),
          fill: "leaf",
        },
        {
          id: "p3",
          shape: "card",
          x: 616,
          y: 140,
          w: 200,
          h: 112,
          title: t("web.library.content.templates.seed.wbTlP3Title"),
          body: t("web.library.content.templates.seed.wbTlP3Body"),
          fill: "water",
        },
      );
      arrows.push(
        { id: "a1", fromId: "p1", fromSide: "e", toId: "p2", toSide: "w", label: "Week 1" },
        { id: "a2", fromId: "p2", fromSide: "e", toId: "p3", toSide: "w", label: "Week 2" },
      );
      break;
    case "journey":
      shapes.push(
        {
          id: "j1",
          shape: "card",
          x: 80,
          y: 120,
          w: 200,
          h: 108,
          title: t("web.library.content.templates.seed.wbJourneyJ1Title"),
          body: t("web.library.content.templates.seed.wbJourneyJ1Body"),
          fill: "default",
        },
        {
          id: "j2",
          shape: "card",
          x: 348,
          y: 120,
          w: 200,
          h: 108,
          title: t("web.library.content.templates.seed.wbJourneyJ2Title"),
          body: t("web.library.content.templates.seed.wbJourneyJ2Body"),
          fill: "leaf",
        },
        {
          id: "j3",
          shape: "card",
          x: 616,
          y: 120,
          w: 200,
          h: 108,
          title: t("web.library.content.templates.seed.wbJourneyJ3Title"),
          body: t("web.library.content.templates.seed.wbJourneyJ3Body"),
          fill: "water",
        },
        {
          id: "s1",
          shape: "sticky",
          x: 348,
          y: 280,
          w: 200,
          h: 96,
          title: t("web.library.content.templates.seed.wbJourneyS1Title"),
          body: t("web.library.content.templates.seed.wbJourneyS1Body"),
          fill: "sun",
        },
      );
      arrows.push(
        { id: "a1", fromId: "j1", fromSide: "e", toId: "j2", toSide: "w", label: t("web.library.content.templates.seed.wbJourneyE1") },
        { id: "a2", fromId: "j2", fromSide: "e", toId: "j3", toSide: "w", label: t("web.library.content.templates.seed.wbJourneyE2") },
      );
      break;
    case "workshop":
      shapes.push(
        {
          id: "w1",
          shape: "card",
          x: 300,
          y: 80,
          w: 220,
          h: 104,
          title: t("web.library.content.templates.seed.wbWorkW1Title"),
          body: t("web.library.content.templates.seed.wbWorkW1Body"),
          fill: "water",
        },
        {
          id: "w2",
          shape: "sticky",
          x: 140,
          y: 248,
          w: 200,
          h: 104,
          title: t("web.library.content.templates.seed.wbWorkW2Title"),
          body: t("web.library.content.templates.seed.wbWorkW2Body"),
          fill: "sun",
        },
        {
          id: "w3",
          shape: "sticky",
          x: 480,
          y: 248,
          w: 200,
          h: 104,
          title: t("web.library.content.templates.seed.wbWorkW3Title"),
          body: t("web.library.content.templates.seed.wbWorkW3Body"),
          fill: "leaf",
        },
      );
      arrows.push(
        { id: "a1", fromId: "w1", fromSide: "s", toId: "w2", toSide: "n", label: t("web.library.content.templates.seed.wbWorkE1") },
        { id: "a2", fromId: "w2", fromSide: "e", toId: "w3", toSide: "w", label: t("web.library.content.templates.seed.wbWorkE2") },
      );
      break;
  }

  const elements: Record<string, unknown> = {};
  for (const s of shapes) {
    elements[s.id] = { id: s.id, type: "shape", shape: s.shape, x: s.x, y: s.y, w: s.w, h: s.h, title: s.title, body: s.body, fill: s.fill };
  }
  for (const a of arrows) {
    elements[a.id] = {
      id: a.id,
      type: "arrow",
      curve: "smooth",
      head: "arrow",
      from: { id: a.fromId, side: a.fromSide },
      to: { id: a.toId, side: a.toSide },
      ...(a.label ? { label: a.label } : {}),
    };
  }
  return { version: 1, grid: "dots", viewport: { x: 0, y: 0, zoom: 1 }, elements };
}

export async function createQuickBlankNote(deps: {
  readonly queries: QueryClient;
  readonly router: RouterController;
  readonly existingNoteTitles: readonly string[];
}): Promise<void> {
  const baseTitle = t("web.library.content.templates.items.noteBlank.name");
  const title = uniqueNoteTitle(baseTitle, deps.existingNoteTitles);
  const outlineJson = `${JSON.stringify(buildOutlineFromMarkdown(title, noteStarterMarkdown("blank")), null, 2)}\n`;
  const made = await createTypedArtifact("outline", title, { content: outlineJson });
  await deps.queries.invalidate({ prefix: ["artifacts"] });
  deps.router.navigate(artifactHref(made.id));
}

export async function createFromTemplate(
  tpl: ContentTemplate,
  deps: {
    readonly queries: QueryClient;
    readonly router: RouterController;
    readonly existingNoteTitles: readonly string[];
  },
): Promise<void> {
  const baseTitle = templateName(tpl);
  switch (tpl.kind) {
    case "note": {
      const title = uniqueNoteTitle(baseTitle, deps.existingNoteTitles);
      const outlineJson = `${JSON.stringify(buildOutlineFromMarkdown(title, noteStarterMarkdown(tpl.variant)), null, 2)}\n`;
      const made = await createTypedArtifact("outline", title, { content: outlineJson });
      await deps.queries.invalidate({ prefix: ["artifacts"] });
      deps.router.navigate(artifactHref(made.id));
      return;
    }
    case "whiteboard": {
      const made = await createTypedArtifact("whiteboard", baseTitle);
      const boardDoc = buildWhiteboardDocument(tpl.variant);
      await api.artifact.file.write({
        id: made.id,
        files: [{ path: BOARD_FILE_PATH, content: `${JSON.stringify(boardDoc, null, 2)}\n`, mime: "application/json" }],
        summary: `Apply ${tpl.variant} template`,
      });
      await deps.queries.invalidate({ prefix: ["artifacts"] });
      deps.router.navigate(artifactHref(made.id));
      return;
    }
    case "deliverable": {
      const made = await createTypedArtifact(tpl.artifactType, baseTitle);
      await deps.queries.invalidate({ prefix: ["artifacts"] });
      deps.router.navigate(artifactHref(made.id));
      return;
    }
    case "ai": {
      deps.router.navigate(`/library?make=${tpl.makeTab}`);
      return;
    }
  }
}
