import { z } from "zod";

import { type Messages, t } from "@vibevalley/i18n";
import type { NoteFileWriteItem } from "@vibevalley/protocol";

import { buildDocFromMarkdown } from "../html";
import rawAppSeeds from "./seeds/appSeeds.json";
import rawDeliverableSeeds from "./seeds/deliverableSeeds.json";
import rawWhiteboardSeeds from "./seeds/whiteboardSeeds.json";

export type NoteTemplateVariant = "blank" | "tech" | "meeting" | "daily" | "prReview" | "debug" | "release" | "oncall" | "onboarding" | "sprintRetro";

export type WhiteboardTemplateVariant = "blank" | "arch" | "timeline" | "journey" | "workshop" | "eventStorming" | "c4" | "incidentMap" | "tradeoff";

type DocDeliverableSeed = "docRfc" | "docAdr" | "docPostmortem" | "docApiSpec" | "docRunbook" | "docSecurity" | "docMigration" | "docPerf";

type AppTemplateSeed =
  | "protoFocusStudio"
  | "protoSynthPad"
  | "protoParticleLab"
  | "protoTokenCalculator"
  | "protoCssGlassStudio"
  | "protoDeskKanban"
  | "protoApiPlayground"
  | "protoComponentLab";

type StructuredDeliverableSeed =
  | "diagMicroservices"
  | "diagSequence"
  | "diagErd"
  | "diagCicd"
  | "diagStateMachine"
  | "sheetBenchmark"
  | "sheetTechMatrix"
  | "sheetTestMatrix"
  | "sheetApiInventory"
  | "dashSlo"
  | "dashDora"
  | "slidesArchReview"
  | "slidesReleaseDemo"
  | "designWorkspaceUi"
  | "dsPapertrails"
  | "motionLaunchReel"
  | "storyboardProductFilm";

export type DeliverableTemplateSeed = DocDeliverableSeed | AppTemplateSeed | StructuredDeliverableSeed;

const SeedAssetItemSchema = z.union([z.object({ path: z.string(), json: z.unknown() }), z.object({ path: z.string(), text: z.string(), mime: z.string() })]);

type SeedAssetItem = z.infer<typeof SeedAssetItemSchema>;

const SeedAssetMapSchema = z.record(z.string(), z.array(SeedAssetItemSchema));
const WhiteboardMapSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

const appSeedsMap = SeedAssetMapSchema.parse(rawAppSeeds);
const deliverableSeedsMap = SeedAssetMapSchema.parse(rawDeliverableSeeds);
const whiteboardSeedsMap = WhiteboardMapSchema.parse(rawWhiteboardSeeds);

const TOKEN_RE = /\{\{(TITLE|\$t:([^|}]+)|\$t_key:([^}]+))\}\}/gu;

function escapeHtml(raw: string): string {
  return raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeJsString(raw: string): string {
  return JSON.stringify(raw).slice(1, -1);
}

type SeedMessageSuffix = {
  [K in keyof Messages]: K extends `web.library.content.templates.seed.${infer S}` ? (Messages[K] extends undefined ? S : never) : never;
}[keyof Messages];

function isSeedMessageSuffix(s: string): s is SeedMessageSuffix {
  return s.length > 0;
}

/** Resolves a `web.library.content.templates.seed.*` key dynamically so static JSON seeds stay bilingual. */
function seedMessage(suffix: string): string {
  if (!isSeedMessageSuffix(suffix)) return "";
  return t(`web.library.content.templates.seed.${suffix}`);
}

function knownExternalMessage(key: string): string {
  if (key === "web.note.base.table") return t("web.note.base.table");
  return key;
}

function interpolateText(raw: string, title: string, mode: "plain" | "html" | "js"): string {
  if (!raw.includes("{{")) return raw;
  const encode = mode === "html" ? escapeHtml : mode === "js" ? escapeJsString : (s: string) => s;
  return raw.replace(TOKEN_RE, (_full, kind: string, seedSuffix: string | undefined, extKey: string | undefined) => {
    if (kind === "TITLE") return encode(title);
    if (seedSuffix !== undefined) return encode(seedMessage(seedSuffix));
    if (extKey !== undefined) return encode(knownExternalMessage(extKey));
    return "";
  });
}

function resolveJsonRecord(value: Readonly<Record<string, unknown>>, title: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = resolveJsonValue(v, title);
  }
  return out;
}

function resolveJsonValue(value: unknown, title: string): unknown {
  if (typeof value === "string") return interpolateText(value, title, "plain");
  if (Array.isArray(value)) return value.map((item) => resolveJsonValue(item, title));
  if (typeof value === "object" && value !== null) {
    return resolveJsonRecord(Object.fromEntries(Object.entries(value)), title);
  }
  return value;
}

function materializeSeedItems(items: readonly SeedAssetItem[], title: string): NoteFileWriteItem[] {
  return items.map((item): NoteFileWriteItem => {
    if ("json" in item) {
      return {
        path: item.path,
        content: `${JSON.stringify(resolveJsonValue(item.json, title), null, 2)}\n`,
        mime: "application/json",
      };
    }
    const mode = item.mime === "text/html" ? "html" : item.mime === "application/javascript" ? "js" : "plain";
    return {
      path: item.path,
      content: interpolateText(item.text, title, mode),
      encoding: "utf8",
      mime: item.mime,
    };
  });
}

export function noteStarterMarkdown(variant: NoteTemplateVariant): string {
  switch (variant) {
    case "blank":
      return "- \n";
    case "tech":
      return t("web.library.content.templates.seed.noteTech");
    case "meeting":
      return t("web.library.content.templates.seed.noteMeeting");
    case "daily":
      return t("web.library.content.templates.seed.noteDaily");
    case "prReview":
      return t("web.library.content.templates.seed.notePrReview");
    case "debug":
      return t("web.library.content.templates.seed.noteDebug");
    case "release":
      return t("web.library.content.templates.seed.noteRelease");
    case "oncall":
      return t("web.library.content.templates.seed.noteOncall");
    case "onboarding":
      return t("web.library.content.templates.seed.noteOnboarding");
    case "sprintRetro":
      return t("web.library.content.templates.seed.noteSprintRetro");
  }
}

export function buildWhiteboardDocument(variant: WhiteboardTemplateVariant): Record<string, unknown> {
  const raw = whiteboardSeedsMap[variant] ?? whiteboardSeedsMap.blank ?? { version: 1, grid: "dots", viewport: { x: 0, y: 0, zoom: 1 }, elements: {} };
  return resolveJsonRecord(raw, "");
}

function buildDocFiles(seed: DocDeliverableSeed, title: string): NoteFileWriteItem[] {
  const bodies: Record<DocDeliverableSeed, string> = {
    docRfc: t("web.library.content.templates.seed.docRfcBody", { title }),
    docAdr: t("web.library.content.templates.seed.docAdrBody", { title }),
    docPostmortem: t("web.library.content.templates.seed.docPostmortemBody", { title }),
    docApiSpec: t("web.library.content.templates.seed.docApiSpecBody", { title }),
    docRunbook: t("web.library.content.templates.seed.docRunbookBody", { title }),
    docSecurity: t("web.library.content.templates.seed.docSecurityBody", { title }),
    docMigration: t("web.library.content.templates.seed.docMigrationBody", { title }),
    docPerf: t("web.library.content.templates.seed.docPerfBody", { title }),
  };
  return [{ path: "structure/doc.json", content: `${JSON.stringify(buildDocFromMarkdown(title, bodies[seed]), null, 2)}\n`, mime: "application/json" }];
}

export function buildDeliverableSeedFiles(seed: DeliverableTemplateSeed, title: string): NoteFileWriteItem[] {
  switch (seed) {
    case "docRfc":
    case "docAdr":
    case "docPostmortem":
    case "docApiSpec":
    case "docRunbook":
    case "docSecurity":
    case "docMigration":
    case "docPerf":
      return buildDocFiles(seed, title);
    case "protoFocusStudio":
    case "protoSynthPad":
    case "protoParticleLab":
    case "protoTokenCalculator":
    case "protoCssGlassStudio":
    case "protoDeskKanban":
    case "protoApiPlayground":
    case "protoComponentLab":
      return materializeSeedItems(appSeedsMap[seed] ?? [], title);
    case "diagMicroservices":
    case "diagSequence":
    case "diagErd":
    case "diagCicd":
    case "diagStateMachine":
    case "sheetBenchmark":
    case "sheetTechMatrix":
    case "sheetTestMatrix":
    case "sheetApiInventory":
    case "dashSlo":
    case "dashDora":
    case "slidesArchReview":
    case "slidesReleaseDemo":
    case "designWorkspaceUi":
    case "dsPapertrails":
    case "motionLaunchReel":
    case "storyboardProductFilm":
      return materializeSeedItems(deliverableSeedsMap[seed] ?? [], title);
  }
}
