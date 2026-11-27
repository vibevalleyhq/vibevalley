import { z } from "zod";

import { type Messages, t } from "@vibevalley/i18n";
import { NOTE_TYPE_SPECS, NOTE_TYPES, type NoteType } from "@vibevalley/protocol";

import type { IconName } from "../../../design/icons";
import { spelled } from "../../../infra/base/search";
import type { QueryClient } from "../../../infra/query";
import type { RouterController } from "../../../infra/router/context";
import type { TemplateCategory } from "../../../infra/state/contentNav";
import { buildDocFromMarkdown } from "../html";
import { noteHref, noteTypeIcon, noteTypeLabel } from "../NoteCard";
import { createTypedNote } from "../store";
import rawCatalog from "./seeds/catalog.json";
import {
  buildDeliverableSeedFiles,
  buildWhiteboardDocument,
  type DeliverableTemplateSeed,
  noteStarterMarkdown,
  type NoteTemplateVariant,
  type WhiteboardTemplateVariant,
} from "./templateSeeds";

type AiMediaMakeTab = "image" | "speech" | "audio";

export type DeliverablePreviewKind =
  | "design-system"
  | "dashboard"
  | "slides"
  | "design"
  | "motion"
  | "prototype"
  | "diagram"
  | "sheet"
  | "storyboard"
  | "document";

type TemplateItemKey = {
  [K in keyof Messages]: K extends `web.library.content.templates.items.${infer Key}.name` ? Key : never;
}[keyof Messages];

interface TemplateBase {
  readonly id: string;
  readonly key: TemplateItemKey;
  readonly category: Exclude<TemplateCategory, "recommended" | "engineering" | "apps">;
  readonly recommended: boolean;
  readonly engineering?: boolean | undefined;
  readonly standaloneApp?: boolean | undefined;
  readonly tags?: readonly string[] | undefined;
}

export type ContentTemplate =
  | (TemplateBase & { readonly kind: "note"; readonly noteType: "doc"; readonly variant: NoteTemplateVariant; readonly icon: IconName })
  | (TemplateBase & { readonly kind: "whiteboard"; readonly noteType: "canvas"; readonly variant: WhiteboardTemplateVariant })
  | (TemplateBase & {
      readonly kind: "deliverable";
      readonly noteType: NoteType;
      readonly previewShape: DeliverablePreviewKind;
      readonly seed?: DeliverableTemplateSeed | undefined;
      readonly icon?: IconName | undefined;
    })
  | (TemplateBase & { readonly kind: "ai"; readonly makeTab: AiMediaMakeTab; readonly icon: IconName });

const TemplateItemKeySchema = z.custom<TemplateItemKey>((v) => typeof v === "string");

const BaseSchema = z.object({
  id: z.string(),
  key: TemplateItemKeySchema,
  category: z.enum(["doc", "base", "canvas", "media", "ai"]),
  recommended: z.boolean(),
  engineering: z.exactOptional(z.boolean()),
  standaloneApp: z.exactOptional(z.boolean()),
  tags: z.exactOptional(z.array(z.string())),
});

const PreviewKindSchema = z.enum(["design-system", "dashboard", "slides", "design", "motion", "prototype", "diagram", "sheet", "storyboard", "document"]);
const NoteTypeSchema = z.enum(NOTE_TYPES);
const IconNameSchema = z.custom<IconName>((v) => typeof v === "string");
const NoteVariantSchema = z.custom<NoteTemplateVariant>((v) => typeof v === "string");
const WhiteboardVariantSchema = z.custom<WhiteboardTemplateVariant>((v) => typeof v === "string");
const DeliverableSeedSchema = z.custom<DeliverableTemplateSeed>((v) => typeof v === "string");

const ContentTemplateSchema: z.ZodType<ContentTemplate> = z.discriminatedUnion("kind", [
  BaseSchema.extend({ kind: z.literal("note"), noteType: z.literal("doc"), variant: NoteVariantSchema, icon: IconNameSchema }),
  BaseSchema.extend({ kind: z.literal("whiteboard"), noteType: z.literal("canvas"), variant: WhiteboardVariantSchema }),
  BaseSchema.extend({
    kind: z.literal("deliverable"),
    noteType: NoteTypeSchema,
    previewShape: PreviewKindSchema,
    seed: z.exactOptional(DeliverableSeedSchema),
    icon: z.exactOptional(IconNameSchema),
  }),
  BaseSchema.extend({ kind: z.literal("ai"), makeTab: z.enum(["image", "speech", "audio"]), icon: IconNameSchema }),
]);

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = ["recommended", "apps", "engineering", "doc", "base", "canvas", "media", "ai"];

export const CONTENT_TEMPLATES: readonly ContentTemplate[] = z.array(ContentTemplateSchema).parse(rawCatalog);

export function templateNoteType(tpl: ContentTemplate): NoteType | undefined {
  switch (tpl.kind) {
    case "note":
    case "whiteboard":
    case "deliverable":
      return tpl.noteType;
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
      return noteTypeIcon.canvas;
    case "deliverable":
      return tpl.icon ?? noteTypeIcon[tpl.noteType];
  }
}

export const templateName = (tpl: ContentTemplate): string => t(`web.library.content.templates.items.${tpl.key}.name`);

export const templateDesc = (tpl: ContentTemplate): string => t(`web.library.content.templates.items.${tpl.key}.desc`);

export function templateBadge(tpl: ContentTemplate): string {
  switch (tpl.kind) {
    case "note":
    case "whiteboard":
    case "deliverable":
      return noteTypeLabel(tpl.noteType);
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
      const docJson = `${JSON.stringify(buildDocFromMarkdown(title, noteStarterMarkdown(tpl.variant)), null, 2)}\n`;
      const made = await createTypedNote("doc", title, {
        files: [{ path: "structure/doc.json", content: docJson, mime: "application/json" }],
      });
      await deps.queries.invalidate({ prefix: ["notes"] });
      deps.router.navigate(noteHref(made.id));
      return;
    }
    case "whiteboard": {
      const boardDoc = buildWhiteboardDocument(tpl.variant);
      const made = await createTypedNote("canvas", baseTitle, {
        files: [{ path: NOTE_TYPE_SPECS.canvas.entryPath, content: `${JSON.stringify(boardDoc, null, 2)}\n`, mime: "application/json" }],
      });
      await deps.queries.invalidate({ prefix: ["notes"] });
      deps.router.navigate(noteHref(made.id));
      return;
    }
    case "deliverable": {
      const files = tpl.seed ? buildDeliverableSeedFiles(tpl.seed, baseTitle) : undefined;
      const made = await createTypedNote(tpl.noteType, baseTitle, files ? { files } : undefined);
      await deps.queries.invalidate({ prefix: ["notes"] });
      deps.router.navigate(noteHref(made.id));
      return;
    }
    case "ai": {
      deps.router.navigate(`/library?make=${tpl.makeTab}`);
      return;
    }
  }
}
