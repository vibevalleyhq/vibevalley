import { t } from "@vibevalley/i18n";
import { ARTIFACT_TYPES, type ArtifactType } from "@vibevalley/protocol";

import type { IconName } from "../../design/icons";
import { spelled } from "../../infra/base/search";
import type { QueryClient } from "../../infra/query";
import type { RouterController } from "../../infra/router/context";
import type { TemplateCategory } from "../../infra/state/contentNav";
import { artifactHref, artifactTypeIcon, artifactTypeLabel, BOARD_FILE_PATH, buildOutlineFromMarkdown, createTypedArtifact } from "../artifact";
import {
  buildDeliverableSeedFiles,
  buildWhiteboardDocument,
  type DeliverableTemplateSeed,
  noteStarterMarkdown,
  type NoteTemplateVariant,
  type WhiteboardTemplateVariant,
} from "./templateSeeds";

type AiMediaMakeTab = "image" | "speech" | "audio";
type DeliverableArtifactType = Exclude<ArtifactType, "outline" | "whiteboard">;

type DeliverableTemplateKey =
  | "artDocs"
  | "artSlides"
  | "artDashboard"
  | "artDesign"
  | "artDesignSystem"
  | "artMotion"
  | "artHtml"
  | "artSheet"
  | "artDiagram"
  | "artStoryboard";

type TemplateItemKey =
  | "noteBlank"
  | "noteTech"
  | "noteMeeting"
  | "noteDaily"
  | "notePrReview"
  | "noteDebug"
  | "noteRelease"
  | "noteOncall"
  | "noteOnboarding"
  | "noteSprintRetro"
  | "wbBlank"
  | "wbArch"
  | "wbTimeline"
  | "wbJourney"
  | "wbWorkshop"
  | "wbEventStorming"
  | "wbC4"
  | "wbIncidentMap"
  | "wbTradeoff"
  | DeliverableTemplateKey
  | DeliverableTemplateSeed
  | "aiImage"
  | "aiSpeech"
  | "aiAudio";

interface TemplateBase {
  readonly id: string;
  readonly key: TemplateItemKey;
  readonly category: Exclude<TemplateCategory, "recommended" | "engineering" | "apps">;
  readonly recommended: boolean;
  readonly engineering?: boolean;
  readonly standaloneApp?: boolean;
  readonly tags?: readonly string[];
}

export type ContentTemplate =
  | (TemplateBase & { readonly kind: "note"; readonly variant: NoteTemplateVariant; readonly icon: IconName })
  | (TemplateBase & { readonly kind: "whiteboard"; readonly variant: WhiteboardTemplateVariant })
  | (TemplateBase & {
      readonly kind: "deliverable";
      readonly artifactType: DeliverableArtifactType;
      readonly seed?: DeliverableTemplateSeed;
      readonly icon?: IconName;
    })
  | (TemplateBase & { readonly kind: "ai"; readonly makeTab: AiMediaMakeTab; readonly icon: IconName });

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = ["recommended", "apps", "engineering", "note", "whiteboard", "deliverable", "ai"];

const DELIVERABLE_TEMPLATE_META: Record<DeliverableArtifactType, { readonly id: string; readonly key: DeliverableTemplateKey; readonly recommended: boolean }> =
  {
    docs: { id: "tpl-art-docs", key: "artDocs", recommended: true },
    slides: { id: "tpl-art-slides", key: "artSlides", recommended: true },
    dashboard: { id: "tpl-art-dashboard", key: "artDashboard", recommended: false },
    design: { id: "tpl-art-design", key: "artDesign", recommended: false },
    "design-system": { id: "tpl-art-design-system", key: "artDesignSystem", recommended: false },
    motion: { id: "tpl-art-motion", key: "artMotion", recommended: false },
    prototype: { id: "tpl-art-prototype", key: "artHtml", recommended: false },
    sheet: { id: "tpl-art-sheet", key: "artSheet", recommended: false },
    diagram: { id: "tpl-art-diagram", key: "artDiagram", recommended: false },
    storyboard: { id: "tpl-art-storyboard", key: "artStoryboard", recommended: false },
  };

const isDeliverableArtifactType = (type: ArtifactType): type is DeliverableArtifactType => type !== "outline" && type !== "whiteboard";

const GENERIC_DELIVERABLE_TEMPLATES: readonly ContentTemplate[] = ARTIFACT_TYPES.filter(isDeliverableArtifactType).map((artifactType) => ({
  id: DELIVERABLE_TEMPLATE_META[artifactType].id,
  key: DELIVERABLE_TEMPLATE_META[artifactType].key,
  category: "deliverable",
  recommended: DELIVERABLE_TEMPLATE_META[artifactType].recommended,
  kind: "deliverable",
  artifactType,
}));

const ENGINEERING_DELIVERABLE_TEMPLATES: readonly ContentTemplate[] = [
  {
    id: "tpl-doc-rfc",
    key: "docRfc",
    category: "deliverable",
    recommended: true,
    engineering: true,
    tags: ["rfc", "design", "spec", "architecture", "proposal"],
    kind: "deliverable",
    artifactType: "docs",
    seed: "docRfc",
    icon: "file",
  },
  {
    id: "tpl-doc-adr",
    key: "docAdr",
    category: "deliverable",
    recommended: true,
    engineering: true,
    tags: ["adr", "architecture", "decision", "tradeoff"],
    kind: "deliverable",
    artifactType: "docs",
    seed: "docAdr",
    icon: "branch",
  },
  {
    id: "tpl-doc-postmortem",
    key: "docPostmortem",
    category: "deliverable",
    recommended: true,
    engineering: true,
    tags: ["postmortem", "incident", "sev", "root-cause", "rca"],
    kind: "deliverable",
    artifactType: "docs",
    seed: "docPostmortem",
    icon: "warn",
  },
  {
    id: "tpl-doc-api-spec",
    key: "docApiSpec",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["api", "http", "rest", "contract", "schema", "openapi"],
    kind: "deliverable",
    artifactType: "docs",
    seed: "docApiSpec",
    icon: "plug",
  },
  {
    id: "tpl-doc-runbook",
    key: "docRunbook",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["runbook", "ops", "sre", "oncall", "rollback"],
    kind: "deliverable",
    artifactType: "docs",
    seed: "docRunbook",
    icon: "terminal",
  },
  {
    id: "tpl-doc-security",
    key: "docSecurity",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["security", "stride", "threat", "auth", "audit"],
    kind: "deliverable",
    artifactType: "docs",
    seed: "docSecurity",
    icon: "lock",
  },
  {
    id: "tpl-doc-migration",
    key: "docMigration",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["migration", "database", "sql", "schema", "backfill"],
    kind: "deliverable",
    artifactType: "docs",
    seed: "docMigration",
    icon: "copy",
  },
  {
    id: "tpl-doc-perf",
    key: "docPerf",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["performance", "benchmark", "latency", "p99", "qps", "flamegraph"],
    kind: "deliverable",
    artifactType: "docs",
    seed: "docPerf",
    icon: "bolt",
  },
  {
    id: "tpl-diag-microservices",
    key: "diagMicroservices",
    category: "deliverable",
    recommended: true,
    engineering: true,
    tags: ["microservices", "topology", "architecture", "gateway"],
    kind: "deliverable",
    artifactType: "diagram",
    seed: "diagMicroservices",
    icon: "devices",
  },
  {
    id: "tpl-diag-sequence",
    key: "diagSequence",
    category: "deliverable",
    recommended: true,
    engineering: true,
    tags: ["sequence", "flow", "rpc", "request", "outbox"],
    kind: "deliverable",
    artifactType: "diagram",
    seed: "diagSequence",
    icon: "send",
  },
  {
    id: "tpl-diag-erd",
    key: "diagErd",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["er", "erd", "database", "schema", "sql", "entity"],
    kind: "deliverable",
    artifactType: "diagram",
    seed: "diagErd",
    icon: "folder",
  },
  {
    id: "tpl-diag-cicd",
    key: "diagCicd",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["ci", "cd", "cicd", "pipeline", "deploy", "canary"],
    kind: "deliverable",
    artifactType: "diagram",
    seed: "diagCicd",
    icon: "bolt",
  },
  {
    id: "tpl-diag-statemachine",
    key: "diagStateMachine",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["fsm", "state", "machine", "lifecycle", "transition"],
    kind: "deliverable",
    artifactType: "diagram",
    seed: "diagStateMachine",
    icon: "branch",
  },
  {
    id: "tpl-sheet-benchmark",
    key: "sheetBenchmark",
    category: "deliverable",
    recommended: true,
    engineering: true,
    tags: ["benchmark", "qps", "p99", "latency", "memory", "sheet"],
    kind: "deliverable",
    artifactType: "sheet",
    seed: "sheetBenchmark",
    icon: "bolt",
  },
  {
    id: "tpl-sheet-tech-matrix",
    key: "sheetTechMatrix",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["matrix", "evaluation", "tradeoff", "comparison", "scoring"],
    kind: "deliverable",
    artifactType: "sheet",
    seed: "sheetTechMatrix",
    icon: "filter",
  },
  {
    id: "tpl-sheet-test-matrix",
    key: "sheetTestMatrix",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["qa", "test", "regression", "matrix", "coverage"],
    kind: "deliverable",
    artifactType: "sheet",
    seed: "sheetTestMatrix",
    icon: "ticked",
  },
  {
    id: "tpl-sheet-api-inventory",
    key: "sheetApiInventory",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["api", "inventory", "endpoints", "rate-limit", "auth"],
    kind: "deliverable",
    artifactType: "sheet",
    seed: "sheetApiInventory",
    icon: "plug",
  },
  {
    id: "tpl-dash-slo",
    key: "dashSlo",
    category: "deliverable",
    recommended: true,
    engineering: true,
    tags: ["slo", "sla", "sli", "reliability", "error-budget", "dashboard"],
    kind: "deliverable",
    artifactType: "dashboard",
    seed: "dashSlo",
    icon: "bolt",
  },
  {
    id: "tpl-dash-dora",
    key: "dashDora",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["dora", "metrics", "mttr", "lead-time", "deploy"],
    kind: "deliverable",
    artifactType: "dashboard",
    seed: "dashDora",
    icon: "calendar",
  },
  {
    id: "tpl-slides-arch-review",
    key: "slidesArchReview",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["slides", "architecture", "review", "deck"],
    kind: "deliverable",
    artifactType: "slides",
    seed: "slidesArchReview",
    icon: "present",
  },
  {
    id: "tpl-slides-release-demo",
    key: "slidesReleaseDemo",
    category: "deliverable",
    recommended: false,
    engineering: true,
    tags: ["slides", "demo", "release", "tech-talk"],
    kind: "deliverable",
    artifactType: "slides",
    seed: "slidesReleaseDemo",
    icon: "present",
  },
  {
    id: "tpl-proto-api-playground",
    key: "protoApiPlayground",
    category: "deliverable",
    recommended: false,
    engineering: true,
    standaloneApp: true,
    tags: ["api", "json", "curl", "sandbox", "schema", "prototype"],
    kind: "deliverable",
    artifactType: "prototype",
    seed: "protoApiPlayground",
    icon: "web",
  },
  {
    id: "tpl-proto-component-lab",
    key: "protoComponentLab",
    category: "deliverable",
    recommended: false,
    engineering: true,
    standaloneApp: true,
    tags: ["ui", "component", "states", "theme", "sandbox", "prototype"],
    kind: "deliverable",
    artifactType: "prototype",
    seed: "protoComponentLab",
    icon: "devices",
  },
  {
    id: "tpl-proto-focus-studio",
    key: "protoFocusStudio",
    category: "deliverable",
    recommended: true,
    standaloneApp: true,
    tags: ["pomodoro", "focus", "timer", "ambient", "app", "prototype"],
    kind: "deliverable",
    artifactType: "prototype",
    seed: "protoFocusStudio",
    icon: "clock",
  },
  {
    id: "tpl-proto-synth-pad",
    key: "protoSynthPad",
    category: "deliverable",
    recommended: true,
    standaloneApp: true,
    tags: ["synth", "audio", "drum", "sequencer", "music", "app"],
    kind: "deliverable",
    artifactType: "prototype",
    seed: "protoSynthPad",
    icon: "audio",
  },
  {
    id: "tpl-proto-particle-lab",
    key: "protoParticleLab",
    category: "deliverable",
    recommended: true,
    standaloneApp: true,
    tags: ["particle", "generative", "canvas", "shader", "art", "app"],
    kind: "deliverable",
    artifactType: "prototype",
    seed: "protoParticleLab",
    icon: "bolt",
  },
  {
    id: "tpl-proto-token-calculator",
    key: "protoTokenCalculator",
    category: "deliverable",
    recommended: false,
    engineering: true,
    standaloneApp: true,
    tags: ["ai", "token", "cost", "pricing", "simulator", "app"],
    kind: "deliverable",
    artifactType: "prototype",
    seed: "protoTokenCalculator",
    icon: "spend",
  },
  {
    id: "tpl-proto-css-glass-studio",
    key: "protoCssGlassStudio",
    category: "deliverable",
    recommended: false,
    standaloneApp: true,
    tags: ["css", "glass", "blur", "gradient", "design", "app"],
    kind: "deliverable",
    artifactType: "prototype",
    seed: "protoCssGlassStudio",
    icon: "appearance",
  },
  {
    id: "tpl-proto-desk-kanban",
    key: "protoDeskKanban",
    category: "deliverable",
    recommended: false,
    standaloneApp: true,
    tags: ["kanban", "todo", "board", "productivity", "app"],
    kind: "deliverable",
    artifactType: "prototype",
    seed: "protoDeskKanban",
    icon: "issues",
  },
  {
    id: "tpl-design-workspace-ui",
    key: "designWorkspaceUi",
    category: "deliverable",
    recommended: true,
    tags: ["design", "ui", "artboard", "responsive", "props"],
    kind: "deliverable",
    artifactType: "design",
    seed: "designWorkspaceUi",
    icon: "devices",
  },
  {
    id: "tpl-ds-papertrails",
    key: "dsPapertrails",
    category: "deliverable",
    recommended: false,
    tags: ["design-system", "tokens", "palette", "components"],
    kind: "deliverable",
    artifactType: "design-system",
    seed: "dsPapertrails",
    icon: "appearance",
  },
  {
    id: "tpl-motion-launch-reel",
    key: "motionLaunchReel",
    category: "deliverable",
    recommended: true,
    tags: ["motion", "animation", "reel", "timeline"],
    kind: "deliverable",
    artifactType: "motion",
    seed: "motionLaunchReel",
    icon: "play",
  },
  {
    id: "tpl-storyboard-product-film",
    key: "storyboardProductFilm",
    category: "deliverable",
    recommended: false,
    tags: ["storyboard", "film", "shots", "script"],
    kind: "deliverable",
    artifactType: "storyboard",
    seed: "storyboardProductFilm",
    icon: "video",
  },
];

export const CONTENT_TEMPLATES: readonly ContentTemplate[] = [
  { id: "tpl-note-blank", key: "noteBlank", category: "note", recommended: true, icon: "notes", kind: "note", variant: "blank" },
  {
    id: "tpl-note-tech",
    key: "noteTech",
    category: "note",
    recommended: true,
    engineering: true,
    tags: ["tech", "spec", "design"],
    icon: "issues",
    kind: "note",
    variant: "tech",
  },
  { id: "tpl-note-meeting", key: "noteMeeting", category: "note", recommended: false, icon: "chat", kind: "note", variant: "meeting" },
  { id: "tpl-note-daily", key: "noteDaily", category: "note", recommended: false, icon: "calendar", kind: "note", variant: "daily" },
  {
    id: "tpl-note-pr-review",
    key: "notePrReview",
    category: "note",
    recommended: false,
    engineering: true,
    tags: ["pr", "code-review", "checklist"],
    icon: "diff",
    kind: "note",
    variant: "prReview",
  },
  {
    id: "tpl-note-debug",
    key: "noteDebug",
    category: "note",
    recommended: false,
    engineering: true,
    tags: ["debug", "bug", "root-cause", "triage"],
    icon: "bug",
    kind: "note",
    variant: "debug",
  },
  {
    id: "tpl-note-release",
    key: "noteRelease",
    category: "note",
    recommended: true,
    engineering: true,
    tags: ["release", "deploy", "canary", "rollback"],
    icon: "check",
    kind: "note",
    variant: "release",
  },
  {
    id: "tpl-note-oncall",
    key: "noteOncall",
    category: "note",
    recommended: false,
    engineering: true,
    tags: ["oncall", "handoff", "alerts", "sre"],
    icon: "clock",
    kind: "note",
    variant: "oncall",
  },
  {
    id: "tpl-note-onboarding",
    key: "noteOnboarding",
    category: "note",
    recommended: false,
    engineering: true,
    tags: ["onboarding", "codebase", "guide"],
    icon: "folder",
    kind: "note",
    variant: "onboarding",
  },
  {
    id: "tpl-note-sprint-retro",
    key: "noteSprintRetro",
    category: "note",
    recommended: false,
    engineering: true,
    tags: ["retro", "sprint", "debt"],
    icon: "refresh",
    kind: "note",
    variant: "sprintRetro",
  },
  { id: "tpl-wb-blank", key: "wbBlank", category: "whiteboard", recommended: true, kind: "whiteboard", variant: "blank" },
  {
    id: "tpl-wb-arch",
    key: "wbArch",
    category: "whiteboard",
    recommended: true,
    engineering: true,
    tags: ["architecture", "system", "whiteboard"],
    kind: "whiteboard",
    variant: "arch",
  },
  {
    id: "tpl-wb-timeline",
    key: "wbTimeline",
    category: "whiteboard",
    recommended: false,
    kind: "whiteboard",
    variant: "timeline",
  },
  {
    id: "tpl-wb-journey",
    key: "wbJourney",
    category: "whiteboard",
    recommended: false,
    kind: "whiteboard",
    variant: "journey",
  },
  {
    id: "tpl-wb-workshop",
    key: "wbWorkshop",
    category: "whiteboard",
    recommended: false,
    kind: "whiteboard",
    variant: "workshop",
  },
  {
    id: "tpl-wb-event-storming",
    key: "wbEventStorming",
    category: "whiteboard",
    recommended: false,
    engineering: true,
    tags: ["ddd", "event-storming", "domain", "cqrs"],
    kind: "whiteboard",
    variant: "eventStorming",
  },
  {
    id: "tpl-wb-c4",
    key: "wbC4",
    category: "whiteboard",
    recommended: false,
    engineering: true,
    tags: ["c4", "container", "architecture", "gateway"],
    kind: "whiteboard",
    variant: "c4",
  },
  {
    id: "tpl-wb-incident-map",
    key: "wbIncidentMap",
    category: "whiteboard",
    recommended: false,
    engineering: true,
    tags: ["incident", "rca", "debug", "triage"],
    kind: "whiteboard",
    variant: "incidentMap",
  },
  {
    id: "tpl-wb-tradeoff",
    key: "wbTradeoff",
    category: "whiteboard",
    recommended: false,
    engineering: true,
    tags: ["tradeoff", "crdt", "ot", "decision"],
    kind: "whiteboard",
    variant: "tradeoff",
  },
  ...GENERIC_DELIVERABLE_TEMPLATES,
  ...ENGINEERING_DELIVERABLE_TEMPLATES,
  { id: "tpl-ai-image", key: "aiImage", category: "ai", recommended: true, icon: "image", kind: "ai", makeTab: "image" },
  { id: "tpl-ai-speech", key: "aiSpeech", category: "ai", recommended: false, icon: "record", kind: "ai", makeTab: "speech" },
  { id: "tpl-ai-audio", key: "aiAudio", category: "ai", recommended: false, icon: "audio", kind: "ai", makeTab: "audio" },
];

export function templateArtifactType(tpl: ContentTemplate): ArtifactType | undefined {
  switch (tpl.kind) {
    case "note":
      return "outline";
    case "whiteboard":
      return "whiteboard";
    case "deliverable":
      return tpl.artifactType;
    case "ai":
      return undefined;
  }
}

export function templateIcon(tpl: ContentTemplate): IconName {
  switch (tpl.kind) {
    case "note":
    case "ai":
      return tpl.icon;
    case "whiteboard":
      return artifactTypeIcon.whiteboard;
    case "deliverable":
      return tpl.icon ?? artifactTypeIcon[tpl.artifactType];
  }
}

export const templateName = (tpl: ContentTemplate): string => t(`web.library.content.templates.items.${tpl.key}.name`);

export const templateDesc = (tpl: ContentTemplate): string => t(`web.library.content.templates.items.${tpl.key}.desc`);

export function templateBadge(tpl: ContentTemplate): string {
  switch (tpl.kind) {
    case "note":
      return artifactTypeLabel("outline");
    case "whiteboard":
      return artifactTypeLabel("whiteboard");
    case "deliverable":
      return artifactTypeLabel(tpl.artifactType);
    case "ai":
      return t("web.library.content.templates.cat.ai");
  }
}

export function templateMatchesQuery(tpl: ContentTemplate, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  if (spelled(templateName(tpl), q) || spelled(templateDesc(tpl), q) || spelled(templateBadge(tpl), q)) return true;
  return tpl.tags?.some((tag) => tag.toLowerCase().includes(q)) ?? false;
}

function uniqueNoteTitle(base: string, existingTitles: readonly string[]): string {
  const taken = new Set(existingTitles.map((s) => s.trim().toLowerCase()));
  if (!taken.has(base.trim().toLowerCase())) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
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
      const boardDoc = buildWhiteboardDocument(tpl.variant);
      const made = await createTypedArtifact("whiteboard", baseTitle, {
        files: [{ path: BOARD_FILE_PATH, content: `${JSON.stringify(boardDoc, null, 2)}\n`, mime: "application/json" }],
      });
      await deps.queries.invalidate({ prefix: ["artifacts"] });
      deps.router.navigate(artifactHref(made.id));
      return;
    }
    case "deliverable": {
      const files = tpl.seed ? buildDeliverableSeedFiles(tpl.seed, baseTitle) : undefined;
      const made = await createTypedArtifact(tpl.artifactType, baseTitle, files ? { files } : undefined);
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
